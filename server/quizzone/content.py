"""Quiz content: language-independent structure + one texts file per language.

content/quiz.json            question ids, correct answer, time, points, penalty
content/texts/<lang>.json    {"<question id>": {"text": ..., "answers": [...], "explanation": ...}}

Italian ('it') is the reference language: every question must exist there.
Other languages may be partial; a missing question falls back to Italian, so a
"bare demo translation" is just a texts file with a few questions.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

REFERENCE_LANG = "it"
MAX_TIME_S = 60          # elapsed time travels as uint16 milliseconds


class ContentError(Exception):
    def __init__(self, problems: List[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass
class Question:
    id: str
    correct: int            # 0-based index of the right answer
    n_answers: int
    time_s: int
    points: int
    penalty: int
    speed_bonus: int
    category: Dict[str, str] = field(default_factory=dict)


@dataclass
class Quiz:
    title: Dict[str, str]
    series: str
    questions: List[Question]
    texts: Dict[str, dict]          # lang -> {qid -> {...}}

    @property
    def languages(self) -> List[str]:
        return sorted(self.texts)

    def localized(self, q: Question, lang: str) -> dict:
        def pick(l):
            t = self.texts.get(l, {}).get(q.id)
            return t if t and isinstance(t.get("answers"), list) and len(t["answers"]) == q.n_answers else None
        t = pick(lang) or pick(REFERENCE_LANG) or {"text": q.id, "answers": [f"#{i + 1}" for i in range(q.n_answers)]}
        cat = q.category.get(lang) or q.category.get(REFERENCE_LANG) or ""
        return {"text": t.get("text", ""), "answers": list(t["answers"]),
                "explanation": t.get("explanation", ""), "category": cat}

    def localized_title(self, lang: str) -> str:
        return self.title.get(lang) or self.title.get(REFERENCE_LANG) or ""


def _intfield(d: dict, key: str, default: int, problems: List[str], where: str, lo: int, hi: int) -> int:
    v = d.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
        problems.append(f"{where}: '{key}' must be an integer between {lo} and {hi} (got {v!r})")
        return default
    return v


def load_quiz(content_dir: str) -> Quiz:
    problems: List[str] = []
    qpath = os.path.join(content_dir, "quiz.json")
    try:
        with open(qpath, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise ContentError([f"cannot read {qpath}: {e}"])

    texts: Dict[str, dict] = {}
    tdir = os.path.join(content_dir, "texts")
    if os.path.isdir(tdir):
        for name in sorted(os.listdir(tdir)):
            if name.endswith(".json"):
                lang = name[:-5]
                try:
                    with open(os.path.join(tdir, name), encoding="utf-8") as f:
                        texts[lang] = json.load(f)
                except (OSError, ValueError) as e:
                    problems.append(f"texts/{name}: {e}")
    if REFERENCE_LANG not in texts:
        problems.append(f"texts/{REFERENCE_LANG}.json is required (reference language)")

    defaults = raw.get("defaults", {})
    questions: List[Question] = []
    seen = set()
    for i, rq in enumerate(raw.get("questions", [])):
        qid = rq.get("id")
        where = f"question #{i + 1} ({qid})"
        if not isinstance(qid, str) or not qid:
            problems.append(f"question #{i + 1}: missing 'id'")
            continue
        if qid in seen:
            problems.append(f"{where}: duplicate id")
        seen.add(qid)
        ref = texts.get(REFERENCE_LANG, {}).get(qid)
        if not ref:
            problems.append(f"{where}: no text in {REFERENCE_LANG}.json")
            continue
        answers = ref.get("answers")
        if not isinstance(answers, list) or not (3 <= len(answers) <= 5) or not all(isinstance(a, str) and a for a in answers):
            problems.append(f"{where}: needs 3 to 5 non-empty answers in {REFERENCE_LANG}.json")
            continue
        if not isinstance(ref.get("text"), str) or not ref["text"].strip():
            problems.append(f"{where}: empty question text in {REFERENCE_LANG}.json")
        n = len(answers)
        correct = rq.get("correct")
        if isinstance(correct, bool) or not isinstance(correct, int) or not (0 <= correct < n):
            problems.append(f"{where}: 'correct' must be an index 0..{n - 1}")
            correct = 0
        merged = {**defaults, **{k: v for k, v in rq.items() if k in ("time_s", "points", "penalty", "speed_bonus")}}
        time_s = _intfield(merged, "time_s", 30, problems, where, 5, MAX_TIME_S)
        points = _intfield(merged, "points", 100, problems, where, 0, 100000)
        penalty = _intfield(merged, "penalty", 50, problems, where, 0, 100000)
        bonus = _intfield(merged, "speed_bonus", 0, problems, where, 0, 100000)
        for lang, tx in texts.items():
            if lang == REFERENCE_LANG or qid not in tx:
                continue
            a2 = tx[qid].get("answers")
            if not isinstance(a2, list) or len(a2) != n:
                problems.append(f"{where}: {lang}.json has {len(a2) if isinstance(a2, list) else 'no'} answers, expected {n}")
        questions.append(Question(qid, correct, n, time_s, points, penalty, bonus, rq.get("category", {}) or {}))
    for lang, tx in texts.items():
        for qid in tx:
            if qid not in seen:
                problems.append(f"texts/{lang}.json: unknown question id '{qid}'")
    if not questions and not problems:
        problems.append("quiz.json contains no questions")
    if problems:
        raise ContentError(problems)
    return Quiz(title=raw.get("title", {}), series=raw.get("series", ""), questions=questions, texts=texts)
