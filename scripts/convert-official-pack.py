"""Convert the track's official material pack into files the server seeds from.

Usage:  python3 scripts/convert-official-pack.py <extracted 智能制造赛道素材包 dir>
Needs:  openpyxl (pip install openpyxl) and pdftotext (poppler) on PATH.
Writes: data/official/tables/<sheet>.csv   — the 16 sheets of 智能制造示例数据集.xlsx, UTF-8
        data/official/policies.json       — the four regulations split into numbered sections
"""
import csv
import datetime
import json
import pathlib
import re
import subprocess
import sys

import openpyxl

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'official'

# Regulation → (document code, owning module) as printed on each document's cover.
DOCS = {
    '人力资源管理制度': 'hr',
    '工厂供应链管理制度': 'supply',
    '工厂品质管理规定': 'quality',
    '工厂智能物流管理制度': 'logistics',
}


def cell(value):
    if value is None:
        return ''
    if isinstance(value, datetime.datetime):
        return value.strftime('%Y-%m-%d') if value.time() == datetime.time(0) else value.strftime('%Y-%m-%d %H:%M')
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def convert_tables(pack: pathlib.Path) -> None:
    out = OUT / 'tables'
    out.mkdir(parents=True, exist_ok=True)
    wb = openpyxl.load_workbook(pack / '智能制造示例数据集.xlsx', read_only=True, data_only=True)
    for ws in wb.worksheets:
        if ws.title.startswith('00_'):
            continue
        rows = [[cell(c) for c in row] for row in ws.iter_rows(values_only=True)]
        rows = [r for r in rows if any(r)]
        name = re.sub(r'[()（）]', '', ws.title)
        with open(out / f'{name}.csv', 'w', newline='', encoding='utf-8') as f:
            csv.writer(f).writerows(rows)
        print(f'table {name}: {len(rows) - 1} rows')


HEADING = re.compile(r'^\s*(\d+\.\d+)\s+(\S.*?)\s*$')
CHAPTER = re.compile(r'^\s*第(.{1,3})章\s*(.+?)\s*$')


def convert_policies(pack: pathlib.Path) -> None:
    sections = []
    for title, module in DOCS.items():
        text = subprocess.run(['pdftotext', '-layout', str(pack / '文档资料' / f'{title}.pdf'), '-'],
                              capture_output=True, text=True, check=True).stdout
        code = re.search(r'文件编号\s+(\S+)', text).group(1)
        version = re.search(r'版本号\s+(\S+)', text).group(1)
        effective = re.search(r'生效日期\s+(\d{4}) 年 (\d{2}) 月 (\d{2}) 日', text)
        effective = '-'.join(effective.groups()) if effective else None
        chapter, current = '', None
        for line in text.splitlines():
            # Running headers and page furniture.
            if 'XXXX 制造有限公司' in line and code in line:
                continue
            if re.fullmatch(r'\s*(第\s*\d+\s*页.*|\d+\s*/\s*\d+|\f)?\s*', line):
                continue
            m = CHAPTER.match(line)
            if m and len(line.strip()) < 40:
                chapter = re.sub(r'\s+', '', m.group(2))
                current = None
                continue
            m = HEADING.match(line)
            if m and len(m.group(2)) < 40 and chapter:
                current = {'id': f'{code}-{m.group(1)}', 'module': module, 'document': title, 'code': code,
                           'version': version, 'effectiveFrom': effective, 'chapter': chapter,
                           'section': m.group(1), 'title': m.group(2), 'lines': []}
                sections.append(current)
                continue
            if current is not None:
                current['lines'].append(line.strip())
        print(f'policy {title}: {sum(1 for s in sections if s["document"] == title)} sections')
    for s in sections:
        body = '\n'.join(s.pop('lines')).strip()
        body = re.sub(r'\n{2,}', '\n', body)
        s['text'] = re.sub(r'[ 　]{2,}', ' ', body)
    sections = [s for s in sections if len(s['text']) >= 10]
    (OUT / 'policies.json').write_text(json.dumps(sections, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'policies.json: {len(sections)} sections')


if __name__ == '__main__':
    pack = pathlib.Path(sys.argv[1])
    convert_tables(pack)
    convert_policies(pack)
