"""Калибровка порога схожести эссе↔Фейнман на реальном экспортированном курсе.

Метрика-кандидат (будет перенесена в src/lib/text-sim.ts):
  tokens(s) = слова длиной >=3, lowercase, ё->е
  containment(a, b) = |A ∩ B| / min(|A|, |B|)
"""
import json
import re

PATH = "/home/z/my-project/upload/edu-game-course-matanfull-nikitin-ezhik-2026-10-08.json"

def tokens(s: str) -> set:
    s = s.lower().replace("ё", "е")
    return {w for w in re.findall(r"[a-zа-я0-9]+", s) if len(w) >= 3}

def containment(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))

with open(PATH, encoding="utf-8") as f:
    payload = json.load(f)

nodes = {n["id"]: n for n in payload["nodes"]}
tasks = payload["tasks"]

essay_by_node = {}
for t in tasks:
    if t.get("type") == "essay":
        essay_by_node.setdefault(t["nodeId"], []).append(t)

rows = []
for node_id, essays in essay_by_node.items():
    node = nodes[node_id]
    fq = node.get("feynmanQuestion", "")
    for t in essays:
        c = containment(t["prompt"], fq)
        # и обратная: пересечение с формулировкой/примером (чтобы видеть фоновый уровень)
        c_form = containment(t["prompt"], node.get("formulation", ""))
        c_ex = containment(t["prompt"], node.get("example", ""))
        rows.append((c, c_form, c_ex, node["title"], t["prompt"][:110], fq[:110]))

rows.sort(reverse=True)
print(f"Всего эссе: {len(rows)}")
print("\n--- TOP-15 по пересечению с feynmanQuestion ---")
for c, cf, ce, title, p, fq in rows[:15]:
    print(f"{c:.2f} (form={cf:.2f} ex={ce:.2f}) «{title}»")
    print(f"   эссе:  {p}")
    print(f"   фейн:  {fq}")

vals = sorted((r[0] for r in rows), reverse=True)
print("\nРаспределение:", " ".join(f"{v:.2f}" for v in vals))
