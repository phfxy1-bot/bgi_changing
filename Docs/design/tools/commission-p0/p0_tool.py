#!/usr/bin/env python3
"""P0 tooling for commission mechanism generalization.

Subcommands:
  validate  Check sample completeness and label consistency (no model needed).
  classify  Classify samples with an OpenAI-compatible VLM endpoint.
  metrics   Compute confusion matrix and accuracy against labels.

Run `p0_tool.py <subcommand> --help` for details.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

MECHANISMS = (
    "dialog", "combat", "collect", "escort", "timed", "photo", "music", "other",
)
TARGETS = ("npc", "enemy", "object", "place", "unknown")
MODES = {
    "text": (),
    "panel": ("panel.png",),
    "scene": ("panel.png", "scene.png", "scene-*.png"),
}

CONF_AUTO = 0.8
CONF_MIN = 0.5

HERE = Path(__file__).resolve().parent
SAMPLES_ROOT = HERE.parents[1] / "commission-samples"
DEFAULT_SAMPLES = SAMPLES_ROOT / "samples"
DEFAULT_LABELS = SAMPLES_ROOT / "labels.csv"
DEFAULT_PROMPT = HERE / "prompt.md"

LABEL_FIELDS = (
    "id", "region", "name", "truth_mechanism", "truth_target",
    "truth_time_limit", "truth_combat", "annotator", "notes",
)


# --------------------------------------------------------------------------- helpers

def read_labels(labels_path: Path) -> tuple[dict[str, dict], list[str]]:
    """Return (labels_by_id, errors). Missing file is an error."""
    errors: list[str] = []
    if not labels_path.exists():
        return {}, [f"标注表不存在: {labels_path}"]
    with labels_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        missing = [k for k in LABEL_FIELDS if k not in (reader.fieldnames or [])]
        if missing:
            return {}, [f"标注表缺少字段: {', '.join(missing)}"]
        rows = list(reader)

    labels: dict[str, dict] = {}
    for lineno, row in enumerate(rows, start=2):
        sid = (row.get("id") or "").strip()
        if not sid:
            continue  # tolerate trailing blank lines
        if sid in labels:
            errors.append(f"标注表第 {lineno} 行: id 重复 ({sid})")
            continue
        labels[sid] = {k: (row.get(k) or "").strip() for k in LABEL_FIELDS}
    return labels, errors


def parse_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("true", "1", "yes", "是"):
        return True
    if text in ("false", "0", "no", "否", ""):
        return False
    raise ValueError(f"无法解析为布尔值: {value!r}")


def sample_dirs(samples_root: Path) -> list[Path]:
    if not samples_root.exists():
        return []
    return sorted(p for p in samples_root.iterdir() if p.is_dir())


def expected_images(sample_dir: Path, mode: str) -> list[Path]:
    found: list[Path] = []
    for pattern in MODES[mode]:
        if "*" in pattern:
            found.extend(sorted(sample_dir.glob(pattern)))
        else:
            found.append(sample_dir / pattern)
    return found


def validate_sample(sample_dir: Path, mode: str) -> list[str]:
    problems: list[str] = []
    desc = sample_dir / "description.txt"
    if not desc.exists():
        problems.append("缺少 description.txt")
    elif not desc.read_text(encoding="utf-8", errors="ignore").strip():
        problems.append("description.txt 为空")
    for image in expected_images(sample_dir, mode):
        if not image.exists():
            problems.append(f"缺少 {image.name}")
        elif image.stat().st_size == 0:
            problems.append(f"{image.name} 为空文件")
    return problems


# --------------------------------------------------------------------------- validate

def cmd_validate(args: argparse.Namespace) -> int:
    labels, label_errors = read_labels(args.labels)
    errors: list[str] = list(label_errors)
    warnings: list[str] = []

    dirs = sample_dirs(args.samples_dir)
    if not dirs:
        print(f"未发现样本目录: {args.samples_dir}")
        print("样本就绪后重新运行 validate。")
        return 0

    seen_ids: set[str] = set()
    for sample_dir in dirs:
        sid = sample_dir.name
        if sid in seen_ids:
            errors.append(f"样本目录重复: {sid}")
        seen_ids.add(sid)
        for problem in validate_sample(sample_dir, args.mode):
            errors.append(f"{sid}: {problem}")

    for sid in sorted(seen_ids - labels.keys()):
        warnings.append(f"{sid}: 尚未填写标注")
    for sid in sorted(labels.keys() - seen_ids):
        errors.append(f"{sid}: 标注表存在但缺少样本目录")

    for sid, row in labels.items():
        if row["truth_mechanism"] not in MECHANISMS:
            errors.append(f"{sid}: truth_mechanism 非法 ({row['truth_mechanism']!r})")
        if row["truth_target"] not in TARGETS:
            errors.append(f"{sid}: truth_target 非法 ({row['truth_target']!r})")
        try:
            int(row["truth_time_limit"])
        except ValueError:
            errors.append(f"{sid}: truth_time_limit 不是整数")
        try:
            parse_bool(row["truth_combat"])
        except ValueError as exc:
            errors.append(f"{sid}: {exc}")

    print(f"样本目录: {len(seen_ids)} 条；已标注: {len(labels)} 条")
    for warning in warnings:
        print(f"[WARN] {warning}")
    for error in errors:
        print(f"[ERROR] {error}")
    if errors:
        print(f"校验失败：{len(errors)} 个错误")
        return 1
    print("校验通过")
    return 0


# --------------------------------------------------------------------------- classify

def encode_image(path: Path) -> str:
    suffix = path.suffix.lower()
    mime = "image/jpeg" if suffix in (".jpg", ".jpeg") else "image/png"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def extract_json(text: str) -> dict:
    cleaned = text.strip()
    cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.S)
        if not match:
            raise ValueError("响应中没有 JSON 对象")
        return json.loads(match.group(0))


def normalize_prediction(payload: dict) -> dict:
    mechanism = payload.get("mechanism")
    if mechanism not in MECHANISMS:
        raise ValueError(f"mechanism 非法: {mechanism!r}")

    try:
        confidence = float(payload.get("confidence"))
    except (TypeError, ValueError):
        raise ValueError("confidence 缺失或不是数字")
    if not 0.0 <= confidence <= 1.0:
        raise ValueError(f"confidence 越界: {confidence}")

    params = payload.get("params")
    if not isinstance(params, dict):
        raise ValueError("params 缺失或不是对象")

    target = str(params.get("target", "unknown")).strip().lower()
    if target not in TARGETS:
        target = "unknown"

    try:
        time_limit = max(0, int(float(params.get("time_limit", 0))))
    except (TypeError, ValueError):
        time_limit = 0

    try:
        combat = parse_bool(params.get("combat", False))
    except ValueError:
        combat = False

    return {
        "mechanism": mechanism,
        "confidence": round(confidence, 3),
        "params": {"target": target, "time_limit": time_limit, "combat": combat},
        "evidence": str(payload.get("evidence", ""))[:60],
    }


def call_model(base_url: str, api_key: str, model: str, messages: list[dict],
               timeout: int) -> str:
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 256,
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def cmd_classify(args: argparse.Namespace) -> int:
    base_url = os.environ.get("VLM_BASE_URL", "")
    api_key = os.environ.get("VLM_API_KEY", "")
    model = os.environ.get("VLM_MODEL", "")
    if not (base_url and api_key and model):
        print("缺少环境变量 VLM_BASE_URL / VLM_API_KEY / VLM_MODEL", file=sys.stderr)
        return 2

    system_prompt = args.prompt.read_text(encoding="utf-8")
    labels, _ = read_labels(args.labels)

    dirs = sample_dirs(args.samples_dir)
    if not dirs:
        print(f"未发现样本目录: {args.samples_dir}", file=sys.stderr)
        return 1
    if args.limit:
        dirs = dirs[: args.limit]

    out = args.out or (args.samples_dir.parent / "output" / f"predictions_{args.mode}.jsonl")
    out.parent.mkdir(parents=True, exist_ok=True)

    failures = 0
    with out.open("w", encoding="utf-8") as sink:
        for index, sample_dir in enumerate(dirs, start=1):
            sid = sample_dir.name
            desc_path = sample_dir / "description.txt"
            if not desc_path.exists():
                record = {"id": sid, "mode": args.mode, "prediction": None,
                          "error": "缺少 description.txt"}
                sink.write(json.dumps(record, ensure_ascii=False) + "\n")
                failures += 1
                continue

            row = labels.get(sid, {})
            text = (
                f"委托名称：{row.get('name') or '未知'}\n"
                f"地区：{row.get('region') or '未知'}\n"
                f"描述文本：\n{desc_path.read_text(encoding='utf-8')}"
            )
            content: list[dict] = [{"type": "text", "text": text}]
            missing = []
            for image in expected_images(sample_dir, args.mode):
                if not image.exists():
                    missing.append(image.name)
                    continue
                content.append({
                    "type": "image_url",
                    "image_url": {"url": encode_image(image), "detail": "high"},
                })

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ]
            started = time.monotonic()
            record: dict = {"id": sid, "mode": args.mode, "missing_images": missing}
            try:
                raw = call_model(base_url, api_key, model, messages, args.timeout)
                record["raw"] = raw
                record["prediction"] = normalize_prediction(extract_json(raw))
            except (urllib.error.URLError, urllib.error.HTTPError, KeyError,
                    ValueError, json.JSONDecodeError) as exc:
                record["prediction"] = None
                record["error"] = f"{type(exc).__name__}: {exc}"
                failures += 1
            record["latency_ms"] = round((time.monotonic() - started) * 1000)
            sink.write(json.dumps(record, ensure_ascii=False) + "\n")
            status = "ok" if record["prediction"] else "FAIL"
            print(f"[{index}/{len(dirs)}] {sid}: {status}")

    print(f"输出: {out}")
    print(f"完成 {len(dirs)} 条，失败 {failures} 条")
    return 0


# --------------------------------------------------------------------------- metrics

def load_predictions(path: Path) -> dict[str, dict]:
    records: dict[str, dict] = {}
    if not path.exists():
        return records
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            records[item["id"]] = item  # 同一 id 后写覆盖先写
    return records


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def cmd_metrics(args: argparse.Namespace) -> int:
    labels, errors = read_labels(args.labels)
    if errors:
        for error in errors:
            print(f"[ERROR] {error}", file=sys.stderr)
        return 1
    if not labels:
        print("标注表为空，无法计算指标。", file=sys.stderr)
        return 1

    pred_path = args.pred or (args.samples_dir.parent / "output" / f"predictions_{args.mode}.jsonl")
    records = load_predictions(pred_path)
    if not records:
        print(f"未找到预测文件或无有效记录: {pred_path}", file=sys.stderr)
        return 1

    truths = sorted(labels)
    matrix: dict[str, Counter] = defaultdict(Counter)
    correct = 0
    invalid = 0
    missing = 0
    conf_buckets = {"high": [0, 0], "mid": [0, 0], "low": [0, 0]}
    param_stats = {"target": [0, 0], "time_limit": [0, 0], "combat": [0, 0]}

    for sid in truths:
        truth = labels[sid]["truth_mechanism"]
        record = records.get(sid)
        if not record:
            missing += 1
            matrix[truth]["MISSING"] += 1
            continue
        prediction = record.get("prediction")
        if not prediction:
            invalid += 1
            matrix[truth]["INVALID"] += 1
            continue

        predicted = prediction["mechanism"]
        matrix[truth][predicted] += 1
        confidence = prediction["confidence"]
        is_correct = predicted == truth
        correct += int(is_correct)
        if confidence >= CONF_AUTO:
            bucket = "high"
        elif confidence >= CONF_MIN:
            bucket = "mid"
        else:
            bucket = "low"
        conf_buckets[bucket][0] += 1
        conf_buckets[bucket][1] += int(is_correct)

        if is_correct:
            params = prediction["params"]
            for key in ("target", "combat"):
                param_stats[key][0] += 1
                param_stats[key][1] += int(str(params[key]).lower()
                                           == str(labels[sid][f"truth_{key}"]).lower())
            param_stats["time_limit"][0] += 1
            param_stats["time_limit"][1] += int(params["time_limit"]
                                                == int(labels[sid]["truth_time_limit"]))

    total = len(truths)
    accuracy = safe_div(correct, total)
    columns = list(MECHANISMS) + ["INVALID", "MISSING"]

    per_class: dict[str, dict] = {}
    for mechanism in MECHANISMS:
        support = sum(matrix[mechanism].values())
        predicted_count = sum(row[mechanism] for row in matrix.values())
        true_positive = matrix[mechanism][mechanism]
        precision = safe_div(true_positive, predicted_count)
        recall = safe_div(true_positive, support)
        f1 = safe_div(2 * precision * recall, precision + recall)
        per_class[mechanism] = {
            "precision": precision, "recall": recall, "f1": f1,
            "support": support, "predicted": predicted_count,
        }

    if accuracy >= 0.90:
        verdict = "通过：机制分类准确率 ≥ 90%，可进入 P1。"
    elif accuracy >= 0.70:
        verdict = "未通过：70%~90%，需补充视觉输入后重测。"
    else:
        verdict = "未通过：< 70%，按方案停止本路线。"

    lines = [
        f"# P0 机制分类评估 — {args.mode}",
        "",
        f"- 生成时间：{datetime.now().isoformat(timespec='seconds')}",
        f"- 预测文件：`{pred_path}`",
        f"- 标注样本数：{total}",
        f"- 有效输出：{total - invalid - missing}（无效 {invalid}，缺失 {missing}）",
        f"- **机制准确率：{accuracy * 100:.1f}%**（{correct}/{total}）",
        "",
        "## 混淆矩阵（行=人工标注，列=模型输出）",
        "",
        "| 标注 \\ 预测 | " + " | ".join(columns) + " |",
        "|---" * (len(columns) + 1) + "|",
    ]
    for truth in MECHANISMS:
        if not sum(matrix[truth].values()):
            continue
        counts = [str(matrix[truth][column]) for column in columns]
        lines.append(f"| {truth} | " + " | ".join(counts) + " |")

    lines += [
        "",
        "## 分类指标",
        "",
        "| mechanism | precision | recall | f1 | support | predicted |",
        "|---|---|---|---|---|---|",
    ]
    for mechanism, stats in per_class.items():
        if not stats["support"] and not stats["predicted"]:
            continue
        lines.append(
            f"| {mechanism} | {stats['precision'] * 100:.1f}% | "
            f"{stats['recall'] * 100:.1f}% | {stats['f1'] * 100:.1f}% | "
            f"{stats['support']} | {stats['predicted']} |"
        )

    lines += [
        "",
        "## 置信度门控",
        "",
        "| 置信度区间 | 数量 | 占比 | 其中正确 | 准确率 |",
        "|---|---|---|---|---|",
    ]
    for name, (count, hits) in conf_buckets.items():
        if not count:
            continue
        ratio = count / total
        lines.append(f"| {name} | {count} | {ratio * 100:.1f}% | {hits} | "
                     f"{safe_div(hits, count) * 100:.1f}% |")
    if invalid or missing:
        lines.append(f"| 无有效输出 | {invalid + missing} | "
                     f"{(invalid + missing) / total * 100:.1f}% | 0 | 0.0% |")

    lines += [
        "",
        "## 参数一致率（机制判定正确的样本内）",
        "",
        "| 参数 | 一致 / 可比 | 一致率 |",
        "|---|---|---|",
    ]
    for key, (comparable, hits) in param_stats.items():
        lines.append(f"| {key} | {hits} / {comparable} | "
                     f"{safe_div(hits, comparable) * 100:.1f}% |")

    lines += ["", "## 结论", "", verdict, ""]
    report = "\n".join(lines)
    print(report)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report, encoding="utf-8")
        print(f"报告已写入: {args.out}")
    return 0 if accuracy >= 0.90 else 1


# --------------------------------------------------------------------------- CLI

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="委托机制泛化 P0 工具",
        epilog=(
            "示例:\n"
            "  python3 Docs/design/tools/commission-p0/p0_tool.py validate\n"
            "  VLM_BASE_URL=... VLM_API_KEY=... VLM_MODEL=... \\\n"
            "    python3 Docs/design/tools/commission-p0/p0_tool.py classify --mode scene\n"
            "  python3 Docs/design/tools/commission-p0/p0_tool.py metrics --mode scene"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--samples-dir", type=Path, default=DEFAULT_SAMPLES,
                       help="样本目录，其下每条样本一个子目录"
                            "（默认 Docs/design/commission-samples/samples）")
        p.add_argument("--labels", type=Path, default=DEFAULT_LABELS,
                       help="标注表路径（默认 commission-samples/labels.csv）")
        p.add_argument("--mode", choices=tuple(MODES), default="scene",
                       help="输入模式：text / panel（文本+面板）/ scene（文本+面板+现场）")

    p_validate = sub.add_parser("validate", help="校验样本与标注完整性")
    add_common(p_validate)
    p_validate.set_defaults(func=cmd_validate)

    p_classify = sub.add_parser("classify", help="调用 VLM 批量分类")
    add_common(p_classify)
    p_classify.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT,
                            help="分类提示词文件")
    p_classify.add_argument("--out", type=Path, default=None,
                            help="预测输出（默认 samples-dir/output/predictions_<mode>.jsonl）")
    p_classify.add_argument("--limit", type=int, default=0, help="只跑前 N 条，0 为全部")
    p_classify.add_argument("--timeout", type=int, default=120, help="单次请求超时秒数")
    p_classify.set_defaults(func=cmd_classify)

    p_metrics = sub.add_parser("metrics", help="计算混淆矩阵与准确率")
    add_common(p_metrics)
    p_metrics.add_argument("--pred", type=Path, default=None,
                           help="预测文件（默认 samples-dir/output/predictions_<mode>.jsonl）")
    p_metrics.add_argument("--out", type=Path, default=None, help="报告输出路径（Markdown）")
    p_metrics.set_defaults(func=cmd_metrics)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
