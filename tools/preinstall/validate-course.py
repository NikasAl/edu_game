#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Валидатор курса edu_game (format version 1) — те же правила, что в приложении:
- ссылки (regionId/nodeId/materialId/from/to) целостны;
- жёсткий мейнлайн — DAG, все узлы достижимы от первого узла;
- expr числовых задач вычислим мини-вычислителем (семантика safeEvalExpr);
- плейсхолдеры {{...}} в промпте ⊆ параметрам; в hints/explanations их быть НЕ должно;
- эссе-зеркала: containment(эссе, feynmanQuestion) >= 0.55 (порт text-sim.ts);
- choice: >=2 опций, опции уникальны, correctIndex в диапазоне;
- essay: expectation >= 2;
- цитаты sourceRef находятcя в material.sourceText (для «Показать источник»).
"""
import json, re, sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'public/preinstalled/index.json'
import glob
if PATH.endswith('index.json'):
    files = [f for f in glob.glob('public/preinstalled/*.json') if not f.endswith('index.json')]
else:
    files = [PATH]

# ---------- мини-вычислитель (семантика safeMath.safeEvalExpr) ----------
import math
def eval_expr(expr, vals):
    def f_round(x, *args): return float(round(x))
    def f_min(*args): return float(min(args))
    def f_max(*args): return float(max(args))
    env = {'sqrt': math.sqrt, 'abs': abs, 'min': f_min, 'max': f_max,
           'round': f_round, 'ln': math.log, 'log': math.log10, 'floor': math.floor,
           'ceil': math.ceil, 'pi': math.pi}
    env.update({k: float(v) for k, v in vals.items()})
    py = re.sub(r'\^', '**', expr)
    if not re.fullmatch(r"[0-9a-zA-Z_+\-*/().,%\s]*", py):
        raise ValueError(f'недопустимые символы в expr: {expr!r}')
    return float(eval(py, {'__builtins__': {}}, env))  # noqa: S307

# ---------- порт text-sim.ts ----------
MIN_WORD_LEN = 3
def content_words(s):
    out = set()
    for w in re.split(r'[^a-zа-я0-9]+', s.lower().replace('ё', 'е')):
        if len(w) >= MIN_WORD_LEN:
            out.add(w)
    return out

def containment(a, b):
    wa, wb = content_words(a), content_words(b)
    if not wa or not wb: return 0.0
    small, big = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return sum(1 for w in small if w in big) / len(small)

errors, warnings = [], []
for path in files:
    with open(path) as f:
        d = json.load(f)
    print(f'== {path}: {len(d["materials"])} materials, {len(d["regions"])} regions, '
          f'{len(d["nodes"])} nodes, {len(d["edges"])} edges, {len(d["tasks"])} tasks')
    mats = {m['id'] for m in d['materials']}
    regs = {r['id'] for r in d['regions']}
    nodes = {n['id']: n for n in d['nodes']}
    node_ids = set(nodes)
    src_text = d['materials'][0].get('sourceText', '')

    for n in d['nodes']:
        if n['materialId'] not in mats: errors.append(f'{n["id"]}: materialId вне комплекта')
        if n['regionId'] not in regs: errors.append(f'{n["id"]}: regionId вне комплекта')
        for fld in ('title', 'formulation', 'example', 'feynmanQuestion'):
            if not (n.get(fld) or '').strip(): errors.append(f'{n["id"]}: пустое {fld}')
        if not n.get('keyTerms'): warnings.append(f'{n["id"]}: пустые keyTerms')
        q = n.get('sourceRef') or ''
        if q and src_text and q[:60] not in src_text:
            warnings.append(f'{n["id"]}: цитата sourceRef не найдена в sourceText (начало: {q[:40]!r})')

    # рёбра
    hard_adj = {}
    for e in d['edges']:
        if e['materialId'] not in mats: errors.append(f'{e["id"]}: edge materialId битый')
        if e['fromNodeId'] not in node_ids or e['toNodeId'] not in node_ids:
            errors.append(f'{e["id"]}: edge ведёт в несуществующий узел'); continue
        if e['kind'] == 'hard':
            hard_adj.setdefault(e['fromNodeId'], []).append(e['toNodeId'])
    # DAG в hard-графе + достижимость.
    # Семантика приложения (progress.ts): locked только по hard-зависимостям;
    # узлы без hard-входов доступны сразу (свободные soft-ветки). Поэтому:
    #  1) hard-граф обязан быть DAG;
    #  2) каждый узел обязан быть достижим в объединённом графе от входов
    #     (узлы без hard-входов) — иначе «висячая» идея, до которой не добраться;
    #  3) hard-ребро от недостижимого узла = вечно закрытый гейт (ошибка).
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in node_ids}
    def dfs(u):
        color[u] = GRAY
        for v in hard_adj.get(u, []):
            if color[v] == GRAY: errors.append(f'цикл в hard-рёбрах: {u} -> {v}')
            elif color[v] == WHITE: dfs(v)
        color[u] = BLACK
    for n in node_ids:
        if color[n] == WHITE: dfs(n)
    all_adj = {}
    hard_in = {n: 0 for n in node_ids}
    for e in d['edges']:
        all_adj.setdefault(e['fromNodeId'], []).append(e['toNodeId'])
    for f_ in hard_adj:
        for t_ in hard_adj[f_]: hard_in[t_] += 1
    entries = [n for n in node_ids if hard_in[n] == 0]
    seen, order = set(), list(entries)
    while order:
        u = order.pop()
        if u in seen: continue
        seen.add(u)
        order.extend(all_adj.get(u, []))
    isolated = node_ids - seen
    if isolated: errors.append(f'узлы, недостижимые ни от одного входа: {sorted(isolated)}')
    reached_hard = set()
    order2 = [n for n in entries]
    while order2:
        u = order2.pop()
        if u in reached_hard: continue
        reached_hard.add(u)
        order2.extend(hard_adj.get(u, []))
    for f_ in hard_adj:
        if f_ not in reached_hard:
            errors.append(f'hard-гейты из недостижимого узла {f_} никогда не откроются')

    # задачи
    ci_dist = {}
    for t in d['tasks']:
        tid, spec = t['id'], t['answerSpec']
        if t['nodeId'] not in node_ids: errors.append(f'{tid}: nodeId битый')
        if not (t.get('hints') or t['type'] == 'essay'): warnings.append(f'{tid}: нет подсказок')
        if not t.get('explanation') and t['type'] != 'essay': errors.append(f'{tid}: нет разбора')
        ph = set(re.findall(r'\{\{(\w+)\}\}', t.get('prompt', '')))
        pnames = {p['name'] for p in (t.get('params') or [])}
        if t['type'] == 'numeric':
            if ph - pnames: errors.append(f'{tid}: плейсхолдеры {ph - pnames} без параметров')
            unused = pnames - ph
            if unused: warnings.append(f'{tid}: параметры {unused} не в промпте (дистракторы?)')
            for name in pnames:
                if not re.search(rf'\b{re.escape(name)}\b', spec['expr']):
                    warnings.append(f'{tid}: параметр {name} не участвует в expr')
            try:
                vals = {p['name']: p['choices'][0] for p in t.get('params') or []}
                r = eval_expr(spec['expr'], vals)
                if math.isnan(r) or math.isinf(r): raise ValueError('не число')
            except Exception as ex_:
                errors.append(f'{tid}: expr {spec["expr"]!r} не вычислим: {ex_}')
            for p in (t.get('params') or []):
                if not p['choices']: errors.append(f'{tid}: пустые choices у {p["name"]}')
        elif t['type'] == 'choice':
            opts = spec['options']
            if len(opts) < 2: errors.append(f'{tid}: <2 опций')
            low = [o.strip().lower() for o in opts]
            if len(low) != len(set(low)): errors.append(f'{tid}: дубли опций')
            if not (0 <= spec['correctIndex'] < len(opts)): errors.append(f'{tid}: correctIndex вне диапазона')
            ci_dist[spec['correctIndex']] = ci_dist.get(spec['correctIndex'], 0) + 1
        elif t['type'] == 'exact':
            if not spec.get('value', '').strip(): errors.append(f'{tid}: пустой эталон exact')
        elif t['type'] == 'essay':
            if len(spec.get('expectation', [])) < 2: errors.append(f'{tid}: expectation < 2')
            c = containment(t['prompt'], nodes[t['nodeId']]['feynmanQuestion'])
            if c >= 0.55:
                print(f'   эссе-зеркало {tid}: containment={c:.2f} (авто-перенос сработает)')
            else:
                print(f'   эссе самостоятельное {tid}: containment={c:.2f}')
        # шаблоны в hints/explanation запрещены
        for i, h in enumerate(t.get('hints') or []):
            if '{{' in h: errors.append(f'{tid}: {{}} в hint{i+1} отрисуется буквально')
        if '{{' in t.get('explanation', ''): errors.append(f'{tid}: {{}} в explanation отрисуется буквально')

    if ci_dist:
        print(f'   correctIndex распределение: {dict(sorted(ci_dist.items()))}')
    kinds = {}
    for t in d['tasks']: kinds[t['type']] = kinds.get(t['type'], 0) + 1
    print(f'   типы задач: {kinds}')

print()
if errors:
    print(f'ОШИБКИ ({len(errors)}):')
    for e_ in errors: print('  ✗', e_)
    sys.exit(1)
print('Все проверки пройдены ✓', f'(предупреждений: {len(warnings)})')
for w in warnings: print('  ⚠', w)
