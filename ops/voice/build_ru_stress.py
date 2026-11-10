# zai voice (FEAT-06.3): builds <models>/ru-stress/ru_stress.db for ru_normalize.py.
#   k (lower-case word as written)  ->  f (the form to send to espeak-ng)
# 1. ё: the RUAccent "yo_words" list (unambiguous е -> ё, e.g. еще -> ещё, отчет -> отчёт).
# 2. stress: words of the RUAccent accent dictionary (not homographs) whose stressed
#    vowel differs from what espeak-ng (Piper's ru phonemizer) says - those get
#    U+0301; a mark is only kept when espeak then really stresses that vowel.
#    Words espeak already stresses right are NOT marked: a mark switches off
#    espeak's own exceptions for the word ("его" would turn into "ег-о").
# Source data (Apache-2.0, https://github.com/Den4ikAI/ruaccent, HF ruaccent/*):
#   <models>/ruaccent/dictionary/{accents,omographs,yo_words}.json.gz
# Run (≈ 4-6 min on a GPU-less mini PC):  D:\Voice\venv\Scripts\python.exe -I build_ru_stress.py [models_dir]
import gzip
import json
import os
import sqlite3
import sys
import time

from piper import espeakbridge
from piper.phonemize_espeak import ESPEAK_DATA_DIR

ACUTE = "\u0301"
VL = "аеёиоуыэюя"
VP = set("aɑʌɐeɛiɪyoɔuɵøəæɨʊ")


def main():
    models = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ZAI_VOICE_MODELS", r"D:\Voice\models")
    src = os.path.join(models, "ruaccent", "dictionary")
    out_dir = os.path.join(models, "ru-stress")
    os.makedirs(out_dir, exist_ok=True)
    espeakbridge.initialize(str(ESPEAK_DATA_DIR))
    espeakbridge.set_voice("ru")

    def phon(w):
        return "".join(p for p, _t, _e in espeakbridge.get_phonemes(w))

    def stressed(p):
        k = p.find("ˈ")
        return None if k < 0 else sum(ch in VP for ch in p[:k])

    t0 = time.time()
    acc = json.load(gzip.open(os.path.join(src, "accents.json.gz")))
    omo = json.load(gzip.open(os.path.join(src, "omographs.json.gz")))
    yo = json.load(gzip.open(os.path.join(src, "yo_words.json.gz")))
    rows = {}
    for k, v in yo.items():
        if k != v and k not in omo:
            rows[k] = v
    n_yo = len(rows)
    checked = fixed = 0
    for w, a in acc.items():
        if "+" not in a or w in omo or not w.isalpha() or "ё" in w or len(w) > 32:
            continue
        clean = a.replace("+", "")
        if clean != w or sum(ch in VL for ch in w) < 2:
            continue
        di = sum(ch in VL for ch in a[: a.index("+")])
        checked += 1
        if stressed(phon(w)) == di:
            continue
        i = a.index("+")
        marked = clean[: i + 1] + ACUTE + clean[i + 1:]
        if stressed(phon(marked)) == di:
            # a word that is also in the ё list keeps the ё form (ё is always stressed)
            rows.setdefault(w, marked)
            fixed += 1
    # 3. feminine noun forms for number agreement in oblique cases: "в 21 строке" ->
    # "двадцати одной", "в 21 файле" -> "двадцати одном". A noun is feminine when
    # its instrumental singular is in the dictionary: строка/строкой, неделя/неделей,
    # область/областью (masculine: файлом, днём, рублём).
    words = set(acc)
    fem = set()
    for w in acc:
        if len(w) < 3 or not w.isalpha():
            continue
        st = w[:-1]
        if w[-1] == "а" and w[-2] not in VL and st + "ой" in words and st + "у" in words:
            fem.update((st + "е", st + "и" if st[-1] in "кгхжшчщ" else st + "ы"))
        elif w[-1] == "я" and st + "ей" in words and st + "ю" in words:
            fem.update((st + "и",) if st.endswith("и") else (st + "е", st + "и"))
        elif w[-1] == "ь" and st + "ью" in words and st + "и" in words:
            fem.update((w, st + "и"))
    path = os.path.join(out_dir, "ru_stress.db")
    tmp = path + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.execute("create table w (k text primary key, f text not null) without rowid")
    db.executemany("insert into w values (?, ?)", sorted(rows.items()))
    db.execute("create table g (k text primary key) without rowid")
    db.executemany("insert into g values (?)", [(k,) for k in sorted(fem)])
    db.execute("create table meta (k text primary key, v text)")
    db.executemany("insert into meta values (?, ?)", [
        ("source", "RUAccent dictionaries (Apache-2.0): accents, omographs, yo_words"),
        ("built", time.strftime("%Y-%m-%d %H:%M")), ("yo", str(n_yo)), ("stress", str(fixed)), ("checked", str(checked)),
        ("fem", str(len(fem)))])
    db.commit()
    db.execute("vacuum")
    db.close()
    os.replace(tmp, path)
    print(json.dumps({"db": path, "yo": n_yo, "stress_checked": checked, "stress_fixed": fixed, "fem": len(fem),
                      "rows": len(rows), "mb": round(os.path.getsize(path) / 1e6, 1), "s": round(time.time() - t0)}))


if __name__ == "__main__":
    main()
