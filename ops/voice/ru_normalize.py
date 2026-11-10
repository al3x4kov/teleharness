# zai voice (FEAT-06.3): Russian text -> what a person would say aloud, before Piper.
#
# Pure stdlib, deterministic, ~1-5 ms per sentence on a GPU-less mini PC. Rule passes:
#   cleanup (emoji, links, markup) -> abbreviations -> dates / times / versions /
#   phones -> ordinals ("5-й", "1990-е", "XXI век") -> numbers with agreement
#   (case from the preposition and the noun ending, gender from the noun) +
#   units / money / percent / ranges -> latin (terms dictionary, spelled
#   acronyms, file names, espeak en-us IPA -> Cyrillic for the rest) ->
#   symbols and pauses -> yo + stress.
# Stress: espeak-ng (Piper's ru phonemizer) honours U+0301 after a vowel, but a
# mark also switches off its exception dictionary for that word ("его" -> "ег-о",
# "тест" -> soft т) - so marks are put ONLY where espeak's own stress is wrong:
# <models>/ru-stress/ru_stress.db (build_ru_stress.py) + a few context rules.
import os
import re
import sqlite3
import unicodedata
from functools import lru_cache

ACUTE = "\u0301"
CASES = ("nom", "gen", "dat", "acc", "ins", "pre")
_C = {c: i for i, c in enumerate(CASES)}
CYR = "А-Яа-яЁё"


def _stress_mark(s):
    """'+' before a vowel -> vowel + U+0301 (combining acute, honoured by espeak-ng)."""
    return re.sub(r"\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])", lambda m: m.group(1) + ACUTE, s)


def _t(s):
    return s.split()


# ------------------------------------------------------------------ cardinals
ZERO = _t("ноль ноля нолю ноль нолём ноле")
ONE = {"m": _t("один одного одному один одним одном"), "f": _t("одна одной одной одну одной одной"),
       "n": _t("одно одного одному одно одним одном")}
TWO = {"m": _t("два двух двум два двумя двух"), "f": _t("две двух двум две двумя двух")}
TWO["n"] = TWO["m"]
UNITS = {3: _t("три трёх трём три тремя трёх"), 4: _t("четыре четырёх четырём четыре четырьмя четырёх"),
         5: _t("пять пяти пяти пять пятью пяти"), 6: _t("шесть шести шести шесть шестью шести"),
         7: _t("семь семи семи семь семью семи"), 8: _t("восемь восьми восьми восемь восемью восьми"),
         9: _t("девять девяти девяти девять девятью девяти")}


def _soft(stem):
    return [stem + "ь", stem + "и", stem + "и", stem + "ь", stem + "ью", stem + "и"]


TEENS = {10 + i: _soft(s) for i, s in enumerate(
    "десят одиннадцат двенадцат тринадцат четырнадцат пятнадцат шестнадцат семнадцат восемнадцат девятнадцат".split())}
TENS = {20: _soft("двадцат"), 30: _soft("тридцат"), 40: _t("сорок сорока сорока сорок сорока сорока"),
        50: _t("пятьдесят пятидесяти пятидесяти пятьдесят пятьюдесятью пятидесяти"),
        60: _t("шестьдесят шестидесяти шестидесяти шестьдесят шестьюдесятью шестидесяти"),
        70: _t("семьдесят семидесяти семидесяти семьдесят семьюдесятью семидесяти"),
        80: _t("восемьдесят восьмидесяти восьмидесяти восемьдесят восемьюдесятью восьмидесяти"),
        90: _t("девяносто девяноста девяноста девяносто девяноста девяноста")}
HUNDREDS = {100: _t("сто ста ста сто ста ста"), 200: _t("двести двухсот двумстам двести двумястами двухстах"),
            300: _t("триста трёхсот трёмстам триста тремястами трёхстах"),
            400: _t("четыреста четырёхсот четырёмстам четыреста четырьмястами четырёхстах"),
            500: _t("пятьсот пятисот пятистам пятьсот пятьюстами пятистах"),
            600: _t("шестьсот шестисот шестистам шестьсот шестьюстами шестистах"),
            700: _t("семьсот семисот семистам семьсот семьюстами семистах"),
            800: _t("восемьсот восьмисот восьмистам восемьсот восемьюстами восьмистах"),
            900: _t("девятьсот девятисот девятистам девятьсот девятьюстами девятистах")}


def agree(n, case):
    """Number + case -> (sg|pl, case) of the counted noun."""
    if case in ("nom", "acc"):
        if n % 100 in (11, 12, 13, 14):
            return "pl", "gen"
        d = n % 10
        if d == 1:
            return "sg", case
        if d in (2, 3, 4):
            return "sg", "gen"
        return "pl", "gen"
    return ("sg", case) if n % 10 == 1 and n % 100 != 11 else ("pl", case)


class Noun:
    def __init__(self, sg, pl, g="m", adj=None, tail=""):
        self.sg, self.pl, self.g, self.adj, self.tail = sg, pl, g, adj, tail

    def form(self, n, case="nom", frac=False):
        num, c = ("sg", "gen") if frac else agree(n, case)
        w = (self.sg if num == "sg" else self.pl)[_C[c]]
        if self.adj:  # "два квадратных метра": nom/acc 2-4 -> adjective gen pl
            an, ac = ("pl", "gen") if (num == "sg" and c == "gen" and not frac and case in ("nom", "acc")) else (num, c)
            w = self.adj[0 if an == "sg" else 1][_C[ac]] + " " + w
        return w + self.tail


def N(sg, pl, g="m", **kw):
    return Noun(_t(sg), _t(pl), g, **kw)


def _hm(stem, gpl=None, g="m"):  # hard masculine: километр
    return Noun([stem, stem + "а", stem + "у", stem, stem + "ом", stem + "е"],
                [stem + "ы", gpl or stem + "ов", stem + "ам", stem + "ы", stem + "ами", stem + "ах"], g)


def _fa(stem, gpl=None):  # feminine in -а: минута, штука
    y = "и" if stem[-1] in "кгхжшчщ" else "ы"
    return Noun([stem + "а", stem + y, stem + "е", stem + "у", stem + "ой", stem + "е"],
                [stem + y, gpl or stem, stem + "ам", stem + y, stem + "ами", stem + "ах"], "f")


def _indecl(w, g="m"):
    return Noun([w] * 6, [w] * 6, g)


def _adjf(stem):
    return ([stem + e for e in ("ый", "ого", "ому", "ый", "ым", "ом")],
            [stem + e for e in ("ые", "ых", "ым", "ые", "ыми", "ых")])


def _with(n, tail="", adj=None):
    return Noun(n.sg, n.pl, n.g, adj, tail)


THOUSAND = N("тысяча тысячи тысяче тысячу тысячей тысяче", "тысячи тысяч тысячам тысячи тысячами тысячах", "f")
MILLION = _hm("миллион")
BILLION = _hm("миллиард")
TRILLION = _hm("триллион")
SCALES = ((10 ** 12, TRILLION), (10 ** 9, BILLION), (10 ** 6, MILLION), (1000, THOUSAND))


def _triad(n, case, g):
    i = _C[case]
    out = []
    h, r = divmod(n, 100)
    if h:
        out.append(HUNDREDS[h * 100][i])
    if 10 <= r <= 19:
        out.append(TEENS[r][i])
    else:
        t, u = divmod(r, 10)
        if t:
            out.append(TENS[t * 10][i])
        if u == 1:
            out.append(ONE[g][i])
        elif u == 2:
            out.append(TWO[g][i])
        elif u:
            out.append(UNITS[u][i])
    return out


def digits(s):
    return " ".join(ZERO[0] if ch == "0" else cardinal(int(ch)) for ch in s if ch.isdigit())


def cardinal(n, case="nom", g="m"):
    n = int(n)
    if n >= 10 ** 15:
        return digits(str(n))
    if n == 0:
        return ZERO[_C[case]]
    out = []
    for size, noun in SCALES:
        q, n = divmod(n, size)
        if q:
            if not (q == 1 and not out):  # "тысяча", "миллион" - not "одна тысяча"
                out += _triad(q, case, noun.g)
            out.append(noun.form(q, case))
    if n:
        out += _triad(n, case, g)
    return " ".join(out)


def compound(n):
    """Number as the first part of a compound word: 5 -> пяти(минутный), 1 -> одно, 100 -> сто."""
    n = int(n)
    if n == 1:
        return "одно"
    if n == 100:
        return "сто"
    if n == 1000:
        return "тысяче"
    parts = _triad(n % 1000, "gen", "m") if n < 1000 else cardinal(n, "gen").split()
    parts = ["девяносто" if p == "девяноста" else p for p in parts]
    if parts and parts[-1] == "одного":
        parts[-1] = "одно"
    return "".join(parts)


# ------------------------------------------------------------------ ordinals
ORD_UNITS = {1: "перв", 2: "втор", 3: "трет", 4: "четвёрт", 5: "пят", 6: "шест", 7: "седьм", 8: "восьм", 9: "девят"}
ORD_TEENS = {10 + i: s for i, s in enumerate(
    "десят одиннадцат двенадцат тринадцат четырнадцат пятнадцат шестнадцат семнадцат восемнадцат девятнадцат".split())}
ORD_TENS = {20: "двадцат", 30: "тридцат", 40: "сороков", 50: "пятидесят", 60: "шестидесят", 70: "семидесят",
            80: "восьмидесят", 90: "девяност"}
ORD_HUND = {100: "сот", 200: "двухсот", 300: "трёхсот", 400: "четырёхсот", 500: "пятисот", 600: "шестисот",
            700: "семисот", 800: "восьмисот", 900: "девятисот"}
_OJ = {"втор", "шест", "седьм", "восьм", "сороков", "нулев"}
_THIRD = {"m": _t("третий третьего третьему третий третьим третьем"),
          "f": _t("третья третьей третьей третью третьей третьей"),
          "n": _t("третье третьего третьему третье третьим третьем"),
          "pl": _t("третьи третьих третьим третьи третьими третьих")}


def _adj_end(stem, case, g):
    i = _C[case]
    if stem == "трет":
        return _THIRD[g][i]
    if g == "pl":
        return stem + ("ые", "ых", "ым", "ые", "ыми", "ых")[i]
    if g == "f":
        return stem + ("ая", "ой", "ой", "ую", "ой", "ой")[i]
    if g == "n":
        return stem + ("ое", "ого", "ому", "ое", "ым", "ом")[i]
    m = "ой" if stem in _OJ else "ый"
    return stem + (m, "ого", "ому", m, "ым", "ом")[i]


def ordinal(n, case="nom", g="m"):
    n = int(n)
    if n == 0:
        return _adj_end("нулев", case, g)
    if n >= 10 ** 6:
        if n % 10 ** 6 == 0 and n < 10 ** 9:
            q = n // 10 ** 6
            return _adj_end(("" if q == 1 else compound(q)) + "миллионн", case, g)
        return cardinal(n)
    if n % 1000 == 0:
        q = n // 1000
        return _adj_end(("" if q == 1 else compound(q)) + "тысячн", case, g)
    words = []
    high = n - n % 1000
    if high:
        words.append(cardinal(high))
    r = n % 100
    h = n % 1000 - r
    if r == 0:
        words.append(_adj_end(ORD_HUND[h], case, g))
    else:
        if h:
            words.append(cardinal(h))
        if r < 10:
            stem = ORD_UNITS[r]
        elif r < 20:
            stem = ORD_TEENS[r]
        else:
            t, u = divmod(r, 10)
            if u:
                words.append(cardinal(t * 10))
                stem = ORD_UNITS[u]
            else:
                stem = ORD_TENS[r]
        words.append(_adj_end(stem, case, g))
    return " ".join(words)


# ------------------------------------------------------------------ nouns / units
KM = _hm("километр")
METER = _hm("метр")
HOUR = N("час часа часу час часом часе", "часы часов часам часы часами часах")
DAY = N("день дня дню день днём дне", "дни дней дням дни днями днях")
MONTH = N("месяц месяца месяцу месяц месяцем месяце", "месяцы месяцев месяцам месяцы месяцами месяцах")
YEAR = N("год года году год годом году", "годы лет годам годы годами годах")
YEARS_PL = _t("годы годов годам годы годами годах")
WEEK = N("неделя недели неделе неделю неделей неделе", "недели недель неделям недели неделями неделях", "f")
RUB = N("рубль рубля рублю рубль рублём рубле", "рубли рублей рублям рубли рублями рублях")
KOP = N("копейка копейки копейке копейку копейкой копейке", "копейки копеек копейкам копейки копейками копейках", "f")
USD = _hm("доллар")
CENT = _hm("цент")
EUR = _indecl("евро")
YUAN = N("юань юаня юаню юань юанем юане", "юани юаней юаням юани юанями юанях")
PCT = _hm("процент")
DEG = _hm("градус")
PERSON = N("человек человека человеку человека человеком человеке", "люди человек людям людей людьми людях")
TIMES = N("раз раза разу раз разом разе", "разы раз разам разы разами разах")
PIXEL = N("пиксель пикселя пикселю пиксель пикселем пикселе", "пиксели пикселей пикселям пиксели пикселями пикселях")
SQ = _adjf("квадратн")
CUB = tuple([w.replace("кубическы", "кубически") for w in f] for f in _adjf("кубическ"))

UNIT_ALIASES = {}


def _alias(names, noun):
    for a in names.split("|"):
        UNIT_ALIASES[a] = noun


_alias("км/ч|км/час|km/h|kmh", _with(KM, " в час"))
_alias("м/с|m/s", _with(METER, " в секунду"))
_alias("км²|км2|кв. км|кв.км", _with(KM, adj=SQ))
_alias("м²|м2|кв. м|кв.м|m²", _with(METER, adj=SQ))
_alias("см²|см2", _with(_hm("сантиметр"), adj=SQ))
_alias("м³|м3|куб. м|куб.м", _with(METER, adj=CUB))
_alias("км|km", KM)
_alias("м", METER)
_alias("см|cm", _hm("сантиметр"))
_alias("мм|mm", _hm("миллиметр"))
_alias("га", _hm("гектар"))
_alias("кг|kg", _hm("килограмм", "килограммов"))
_alias("г|гр", _hm("грамм", "граммов"))
_alias("мг|mg", _hm("миллиграмм", "миллиграммов"))
_alias("т", _fa("тонн"))
_alias("л", _hm("литр"))
_alias("мл|ml", _hm("миллилитр"))
_alias("°C|°С|℃|° C|° С", _with(DEG, " Цельсия"))
_alias("°F|° F", _with(DEG, " по Фаренгейту"))
_alias("°", DEG)
_alias("%", PCT)
_alias("‰", _indecl("промилле"))
_alias("₽|руб.|руб|р.|RUB|rub", RUB)
_alias("коп.|коп", KOP)
_alias("$|USD|долл.|долл", USD)
_alias("€|EUR", EUR)
_alias("£|GBP", _hm("фунт"))
_alias("¥|CNY", YUAN)
_alias("₸|KZT", _indecl("тенге"))
_alias("ГБ|Гб|гб|GB|Gb", _hm("гигабайт", "гигабайт"))
_alias("МБ|Мб|мб|MB|Mb", _hm("мегабайт", "мегабайт"))
_alias("КБ|Кб|кб|KB|kB|Kb", _hm("килобайт", "килобайт"))
_alias("ТБ|Тб|TB", _hm("терабайт", "терабайт"))
_alias("Гбит/с|Gbps|Гбит/сек", _with(_hm("гигабит", "гигабит"), " в секунду"))
_alias("Мбит/с|Mbps|Мбит/сек", _with(_hm("мегабит", "мегабит"), " в секунду"))
_alias("ГГц|GHz", _hm("гигагерц", "гигагерц"))
_alias("МГц|MHz", _hm("мегагерц", "мегагерц"))
_alias("кГц|kHz", _hm("килогерц", "килогерц"))
_alias("Гц|Hz", _hm("герц", "герц"))
_alias("кВт·ч|кВт*ч|кВтч|kWh", _with(_hm("киловатт", "киловатт"), "-час"))
_alias("кВт|kW", _hm("киловатт", "киловатт"))
_alias("МВт|MW", _hm("мегаватт", "мегаватт"))
_alias("Вт", _hm("ватт", "ватт"))
_alias("В", _hm("вольт", "вольт"))
_alias("мАч|мА·ч|mAh", Noun(["миллиампер-" + w for w in HOUR.sg], ["миллиампер-" + w for w in HOUR.pl]))
_alias("мс|ms|мсек", _fa("миллисекунд"))
_alias("мкс", _fa("микросекунд"))
_alias("сек.|сек|с|sec", _fa("секунд"))
_alias("мин.|мин|min", _fa("минут"))
_alias("ч.|ч|h", HOUR)
_alias("дн.|дн", DAY)
_alias("нед.", WEEK)
_alias("мес.|мес", MONTH)
_alias("px|пикс.|пкс", PIXEL)
_alias("fps|FPS", _with(_hm("кадр"), " в секунду"))
_alias("rps|RPS", _with(_hm("запрос"), " в секунду"))
_alias("шт.|шт", _fa("штук"))
_alias("чел.|чел", PERSON)
_UNIT_KEYS = sorted(UNIT_ALIASES, key=len, reverse=True)
# single letters / ambiguous short aliases need a hard right boundary
_STRICT = {"с", "г", "т", "л", "В", "h", "р.", "м", "гр"}
_DIST = {id(UNIT_ALIASES[k]) for k in ("км", "м", "см", "мм")}
MULTS = {"тыс.": THOUSAND, "тыс": THOUSAND, "млн.": MILLION, "млн": MILLION, "млрд.": BILLION, "млрд": BILLION,
         "трлн.": TRILLION, "трлн": TRILLION}
CUR_PRE = {"$": USD, "€": EUR, "£": UNIT_ALIASES["£"], "¥": YUAN, "₽": RUB, "₸": UNIT_ALIASES["₸"]}
SUBUNIT = {id(RUB): KOP, id(USD): CENT, id(EUR): CENT}

MONTHS_GEN = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября",
              "ноября", "декабря")
MONTH_RE = "|".join(MONTHS_GEN)
MONTH_ANY = r"(?:январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*"

# ------------------------------------------------------------------ context: case and gender
GEN_P = set(_t("без для до из от у около после кроме вокруг среди против вместо мимо свыше более менее больше "
               "меньше порядка возле внутри вне напротив ради из-за из-под посреди вдоль сверх накануне позже раньше "
               "выше ниже дороже дешевле старше младше моложе длиннее короче быстрее медленнее начиная"))
DAT_P = {"к", "ко", "благодаря", "согласно", "вопреки", "навстречу"}
PRE_P = {"о", "об", "обо", "при"}
INS_P = {"между", "над", "под", "перед", "надо", "подо", "передо"}
LOC_P = {"в", "во", "на"}
ACC_P = {"за", "через", "про", "сквозь"}
MASC_A = set(_t("папа дядя мужчина юноша судья слуга дедушка"))
FEM_SOFT = set(_t("модель цель роль связь запись часть сеть власть дверь ночь вещь речь мощь помощь мышь ложь "
                  "площадь лошадь тетрадь кровать печать тень степень очередь мысль соль боль постель область "
                  "память жизнь смерть новость сумма ссылка ветвь кровь любовь бровь осень зелень прибыль "
                  "единица"))
_NOUN_IJ = ("ние", "тие", "вие", "рий", "лий", "ций", "зий", "дий", "сий", "мий", "ний", "тий")
_ADJ_END = ("ый", "ий", "ой", "ая", "яя", "ое", "ее", "ые", "ие", "ых", "их", "ым", "им", "ыми", "ими", "ую", "юю",
            "ого", "его", "ому", "ему")


def _is_adj(w):
    return len(w) > 3 and w.endswith(_ADJ_END) and not w.endswith(_NOUN_IJ)


def _lex_fem(w):
    sd = stress_dict()
    return sd.fem(w) if sd else None


def _fem_soft(w):
    lx = _lex_fem(w)
    if lx is not None and w not in FEM_SOFT:
        return lx
    return w in FEM_SOFT or w.endswith(("ость", "есть", "знь", "сль")) or (w.endswith("ь") and len(w) > 2 and w[-2] in "жшчщ")


_SKIP = {"примерно", "приблизительно", "почти", "ровно", "всего", "лишь", "только", "плюс-минус", "плюс", "минус"}


def _prev_word(s, i):
    chunk = s[max(0, i - 60):i]
    for _ in range(3):
        m = re.search(r"([%s-]+)\s+$" % CYR, chunk)
        if not m:
            return ""
        w = m.group(1).lower()
        if w not in _SKIP:
            return w
        chunk = chunk[:m.start()]
    return ""


def _next_words(s, i, k=2):
    m = re.match(r"\s*((?:[%s]+[\s]*){1,%d})" % (CYR, k), s[i:i + 60])
    return [w.lower() for w in m.group(1).split()][:k] if m else []


def case_from_prep(prev, n=None):
    if prev in GEN_P or prev in ("с", "со"):
        return "gen"
    if prev in DAT_P:
        return "dat"
    if prev in PRE_P:
        return "pre"
    if prev in INS_P:
        return "ins"
    if prev == "по":
        return "dat" if n is not None and n % 10 == 1 and n % 100 != 11 else "acc"
    if prev in LOC_P or prev in ACC_P:
        return "acc"
    return "nom"


def case_from_context(prev, words, n, frac=False):
    base = case_from_prep(prev, n)
    if not words:
        return base
    ws = words[:2] if _is_adj(words[0]) and len(words) > 1 else words[:1]
    singular = not frac and n % 10 == 1 and n % 100 != 11
    for w in ws:
        if not singular:
            if w.endswith(("ами", "ями", "ьми", "ыми", "ими")):
                return "ins"
            if w.endswith(("ах", "ях")):
                return "pre"
            if w.endswith(("ам", "ям")) or (_is_adj(w) and w.endswith(("ым", "им"))):
                return "dat"
            if _is_adj(w) and w.endswith(("ых", "их")) and (prev in LOC_P or prev in PRE_P):
                return "pre"
            if (base in ("nom", "acc") and 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14
                    and w.endswith(("ов", "ев", "ёв", "ей")) and not frac):
                return "gen"
        else:
            if (prev in LOC_P or prev in PRE_P) and w.endswith(("е", "и")) and not w.endswith(("ие", "ые", "ее")):
                return "pre"
            if base == "nom" and w.endswith(("у", "ю", "ую", "юю")):
                return "acc"
            if prev in ("с", "со", "за", "между", "над", "под", "перед") and w.endswith(("ом", "ем", "ём", "ой", "ей", "ью")):
                return "ins"
    return base


def gender_from_words(words, n, case, frac=False):
    if not words:
        return "m"
    w = words[0]
    if _is_adj(w):
        if w.endswith(("ая", "яя", "ую", "юю")):
            return "f"
        if w.endswith(("ое", "ее")):
            return "n"
        if w.endswith(("ый", "ий")):
            return "m"
        if len(words) > 1:
            w = words[1]
    singular = not frac and n % 10 == 1 and n % 100 != 11
    if singular:
        if case in ("nom", "acc"):
            if w.endswith(("а", "я")) and w not in MASC_A and case == "nom":
                return "f"
            if w.endswith(("у", "ю")) and case == "acc":
                return "f"
            if w.endswith(("о", "е", "ё")) or w.endswith("мя"):
                return "n"
            if w.endswith("ь"):
                return "f" if _fem_soft(w) else "m"
            return "m"
        if w.endswith(("ой", "ою", "ью")) or (w.endswith("ей") and case in ("gen", "dat", "ins", "pre")):
            return "f"
        if case == "gen" and w.endswith(("ы", "и")):
            return "f"
        if w.endswith(("е", "и")) and _lex_fem(w):
            return "f"
        if case == "dat" and w.endswith("е"):
            return "f"
        return "m"
    if case in ("nom", "acc") and 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 and w.endswith(("ы", "и")):
        return "f"
    if frac and w.endswith(("ы", "и")):
        return "f"
    return "m"


# ------------------------------------------------------------------ amounts (int / decimal)
HALF = _t("половина половины половине половину половиной половине")
CEL = {"sg": _t("целая целой целой целую целой целой"), "pl": _t("целых целых целым целых целыми целых")}
DENOM = {1: "десят", 2: "сот", 3: "тысячн"}


def _poltora(case, g):
    if case in ("nom", "acc"):
        return "полторы" if g == "f" else "полтора"
    return "полутора"


def amount_agree(txt):
    """-> (agree_n, frac): how the counted noun agrees with this amount."""
    if re.search(r"[.,]", txt):
        i, f = re.split(r"[.,]", txt)
        if f.strip("0") == "":
            return int(i), False
        if f == "5":
            return (1, True) if int(i) == 0 else ((2, False) if int(i) == 1 else (int(i), False))
        return 2, True
    return int(txt), False


def amount(txt, case="nom", g="m", deg=False):
    if not re.search(r"[.,]", txt):
        if len(txt) > 1 and txt.startswith("0"):
            return digits(txt)
        return cardinal(int(txt), case, g)
    i, f = re.split(r"[.,]", txt)
    ip = int(i)
    if f.strip("0") == "":
        return cardinal(ip, case, g)
    if f == "5":
        if ip == 0:
            return HALF[_C[case]]
        if ip == 1:
            return _poltora(case, g)
        return cardinal(ip, case, g) + " с половиной"
    if len(f) > 3:
        return cardinal(ip, case, g) + " запятая " + digits(f)
    fn = int(f)
    one = fn % 10 == 1 and fn % 100 != 11
    den = _adj_end(DENOM[len(f)], case, "f") if one else (
        DENOM[len(f)] + ("ых", "ых", "ым", "ых", "ыми", "ых")[_C[case]])
    frac_words = cardinal(fn, case, "f") + " " + den
    if deg and len(f) == 1:
        return cardinal(ip, case, g) + " и " + frac_words
    ione = ip % 10 == 1 and ip % 100 != 11
    cel = CEL["sg" if ione else "pl"][_C[case]]
    return cardinal(ip, case, "f") + " " + cel + " " + frac_words


# ------------------------------------------------------------------ cleanup / symbols
_EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF\u2B00-\u2BFF\uFE0F\u200D\u20E3"
                    "\u2190-\u21FF\u2700-\u27BF\u2300-\u23FF\u25A0-\u25FF]")
_URL = re.compile(r"(?:https?://|www\.)\S+?(?=[.,;:!?)»\"']*(?:\s|$))", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_HEX = re.compile(r"(?<![\w.])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![\w])")


def _cleanup(s):
    s = unicodedata.normalize("NFC", s)
    s = s.replace("\u00a0", " ").replace("\u202f", " ").replace("\u2009", " ").replace("\u200b", "")
    # BUG-167: «ссылка https://…» / «по ссылке: https://…» — keep the word, the
    # address becomes «в чате»; also collapse «ссылка ссылка в чате» from older
    # clients (the client cleaner used to insert its own «ссылка в чате»).
    s = re.sub(r"(ссылк[а-яё]*)\s*[:—–-]?\s*(?=(?:https?://|www\.))", r"\1 ", s, flags=re.I)
    s = re.sub(r"(ссылк[а-яё]*) " + _URL.pattern, r"\1 в чате", s, flags=re.I)
    s = _URL.sub("ссылка в чате", s)
    s = re.sub(r"(ссылк[а-яё]*)\s+ссылка в чате", r"\1 в чате", s, flags=re.I)
    s = _EMAIL.sub("адрес в чате", s)
    s = re.sub(r"\s*(?:->|=>|→|⇒|⟶|➜|➔|<-|←)\s*", ", ", s)
    s = re.sub(r"(?:(?<=\s)|(?<=\())(?::)(?=\d)", "", s)  # ":80", "(:4172)" - a port
    s = _EMOJI.sub(" ", s)
    s = re.sub(r"[✓✔✅☑]", " ", s)
    s = _HEX.sub(" ", s)
    s = re.sub(r"[`*]+", " ", s)
    s = re.sub(r"(?<![\w])_+|_+(?![\w])", " ", s)
    s = re.sub(r"[«»“”„\"]", "", s)
    s = s.replace("…", "...")
    # line breaks / list items -> sentence breaks (espeak needs ". " + a capital for a pause)
    lines = [ln.strip() for ln in re.split(r"\s*\n+\s*", s) if ln.strip()]
    lines = [re.sub(r"^(?:[-•·*+]|\d{1,3}[.)])\s+", "", ln) for ln in lines]
    s = " ".join(ln if re.search(r"[.!?:;…,]$", ln) else ln + "." for ln in lines[:-1]) + (
        (" " if len(lines) > 1 else "") + lines[-1] if lines else "")
    return s


# ------------------------------------------------------------------ abbreviations
ABBR_EARLY = [
    (r"\bт\.\s?е\.", "то есть"), (r"\bи\s+т\.\s?д\.", "и так далее"), (r"\bт\.\s?д\.", "так далее"),
    (r"\bи\s+т\.\s?п\.", "и тому подобное"), (r"\bт\.\s?п\.", "тому подобное"), (r"\bт\.\s?к\.", "так как"),
    (r"\bт\.\s?н\.", "так называемый"), (r"\bв\s+т\.\s?ч\.", "в том числе"), (r"\bт\.\s?о\.", "таким образом"),
    (r"\bи\s+др\.", "и другие"), (r"\bи\s+пр\.", "и прочее"), (r"\bнапр\.", "например"),
    (r"\bок\.(?=\s?\d)", "около"), (r"\bприбл\.(?=\s?\d)", "приблизительно"),
    (r"\bстр\.\s?(?=\d)", "страница "), (r"(?<![\d\s])\s*\bс\.\s?(?=\d)", " страница "),
    (r"\bгл\.\s?(?=\d)", "глава "), (r"\bпп\.\s?(?=\d)", "пункты "), (r"\bп\.\s?(?=\d)", "пункт "),
    (r"\bст\.\s?(?=\d)", "статья "), (r"\bч\.\s?(?=\d)", "часть "), (r"\bрис\.\s?", "рисунок "),
    (r"\bтабл\.\s?", "таблица "), (r"\bд\.\s?(?=\d)", "дом "), (r"\bкв\.\s?(?=\d)", "квартира "),
    (r"\bкорп\.\s?(?=\d)", "корпус "), (r"\bвер\.\s?(?=\d)", "версия "),
    (r"№\s*№", "номера"), (r"№\s?", "номер "), (r"(?<![\w&])#(?=\d)", "номер "),
    (r"\bкол-во\b", "количество"), (r"\bр-н\b", "район"),
    (r"\be\.\s?g\.", "например"), (r"\bi\.\s?e\.", "то есть"), (r"\betc\.?(?=\s|$|[,;:)])", "и так далее"),
    (r"\bvs\.?(?=\s)", "против"), (r"\baka\b", "он же"),
]
ABBR_LATE = [
    (r"\bдр\.", "другие"), (r"\bпр\.", "прочее"), (r"(?<!\d\s)(?<!\d)\bсм\.", "смотри"), (r"\bср\.", "сравни"),
    (r"\bстр\.", "страница"), (r"\bул\.", "улица"), (r"\bпросп\.|\bпр-т\b", "проспект"), (r"\bпер\.", "переулок"),
    (r"\bг\.\s?(?=[А-ЯЁ])", "город "), (r"\bим\.\s?", "имени "), (r"\bпроф\.", "профессор"),
    (r"\bакад\.", "академик"), (r"\bдоц\.", "доцент"), (r"\bприм\.", "примечание"), (r"\bмакс\.", "максимум"),
    (r"\bгг\.", "годы"), (r"\bвв\.", "века"), (r"\bтыс\.", "тысяч"), (r"\bмлн\b\.?", "миллионов"),
    (r"\bмлрд\b\.?", "миллиардов"), (r"\bтрлн\b\.?", "триллионов"), (r"\bруб\.", "рублей"), (r"\bкоп\.", "копеек"),
    (r"\bангл\.", "английский"), (r"\bрус\.", "русский"), (r"\bлат\.", "латинский"), (r"\bзам\.", "заместитель"),
    (r"\bгос\.", "государственный"), (r"\bмин\.(?=\s|$)", "минимум"), (r"\bсек\.(?=\s|$)", "секунд"),
    (r"\bдол\.", "долларов"), (r"\bшт\.", "штук"), (r"\bчел\.", "человек"),
]
ABBR_EARLY = [(re.compile(p, re.I), r) for p, r in ABBR_EARLY]
ABBR_LATE = [(re.compile(p, 0 if "А-ЯЁ" in p else re.I), r) for p, r in ABBR_LATE]


def _end_dot(src, end):
    """The abbreviation's dot (src[end-1]) also ended the sentence."""
    return src[end - 1:end] == "." and re.match(r"\s*(?:$|[А-ЯЁA-Z])", src[end:end + 3]) is not None


# abbreviations that stand before a name / number never end a sentence: "ул. Ленина"
_PREFIX_ABBR = {"улица", "проспект", "переулок", "город", "имени", "профессор", "академик", "доцент", "смотри",
                "сравни", "страница", "рисунок", "таблица", "глава", "пункт", "пункты", "статья", "часть", "дом",
                "квартира", "корпус", "версия", "около", "приблизительно", "например", "заместитель", "номер"}


def _abbr(s, table):
    for rx, rep in table:
        keep = rep.strip() not in _PREFIX_ABBR
        s = rx.sub(lambda m, r=rep, k=keep: r + ("." if k and _end_dot(m.string, m.end()) else ""), s)
    return s


# ------------------------------------------------------------------ dates, times, versions, phones
def _date_case(s, i):
    prev = _prev_word(s, i)
    before = s[max(0, i - 3):i]
    if prev in GEN_P or prev in ("с", "со"):
        return "gen"
    if prev in DAT_P:
        return "dat"
    if prev in ("по", "на", "за", "через", "в"):
        return "acc"
    if prev in ("сегодня", "завтра", "вчера", "сейчас", "это", "дата", "наступит", "будет", "было", "был", "была"):
        return "nom"
    if i == 0 or re.search(r"(?:^|[.!?:—–-])\s*$", s[:i]) or not before.strip():
        return "nom"
    return "gen"


def _date_words(d, m, y, case):
    out = ordinal(d, case, "n") + " " + MONTHS_GEN[m - 1]
    if y is not None:
        out += " " + ordinal(y, "gen") + " года"
    return out


def _year_val(y):
    y = int(y)
    return y + 2000 if y < 100 else y


def _dates(s):
    def full(m):
        d, mo = int(m.group(1)), int(m.group(2))
        if not (1 <= d <= 31 and 1 <= mo <= 12):
            return m.group(0)
        y = _year_val(m.group(3))
        tail = m.group(4) or ""
        return _date_words(d, mo, y, _date_case(s, m.start())) + (" " if tail and not tail.strip(" .") else "")
    s = re.sub(r"(?<![\d.,/])(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?![\d.,/]\d)(\s?(?:г\.|года)(?=\s|$|[,;:!?)]))?", full, s)

    def iso(m):
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if not (1 <= d <= 31 and 1 <= mo <= 12):
            return m.group(0)
        return _date_words(d, mo, y, _date_case(s, m.start()))
    s = re.sub(r"(?<![\d.-])(\d{4})-(\d{2})-(\d{2})(?!\d)", iso, s)

    def ddmm(m):
        d, mo = int(m.group(1)), int(m.group(2))
        if not (1 <= d <= 31 and 1 <= mo <= 12):
            return m.group(0)
        return _date_words(d, mo, None, _date_case(s, m.start()))
    s = re.sub(r"(?<![\d.,])(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])(?![\d]|\.\d|,\d)", ddmm, s)
    s = re.sub(r"(?<![\d.,])([1-9]|[12]\d|3[01])\.(0[1-9])(?![\d]|\.\d|,\d)", ddmm, s)

    # "с 5 по 10 ноября", "5–7 ноября", "5 ноября 2026 г."
    def span(m):
        p, d1, conj, d2, mon = m.group(1), int(m.group(2)), m.group(3), int(m.group(4)), m.group(5)
        c2 = "acc" if conj == "по" else "gen"
        return f"{p} {ordinal(d1, 'gen', 'n')} {conj} {ordinal(d2, c2, 'n')} {mon}"
    s = re.sub(r"\b(с|со|от)\s+(\d{1,2})\s+(по|до)\s+(\d{1,2})\s+(%s)\b" % MONTH_RE, span, s, flags=re.I)

    def drange(m):
        c = _date_case(s, m.start())
        return f"{ordinal(int(m.group(1)), c, 'n')}-{ordinal(int(m.group(2)), c, 'n')} {m.group(3)}"
    s = re.sub(r"(?<![\d.,])(\d{1,2})\s?[–—-]\s?(\d{1,2})\s+(%s)\b" % MONTH_RE, drange, s)

    def dmon(m):
        c = _date_case(s, m.start())
        out = ordinal(int(m.group(1)), c, "n") + " " + m.group(2)
        if m.group(3):
            out += " " + ordinal(int(m.group(3)), "gen") + " года"
        return out
    s = re.sub(r"(?<![\d.,])(\d{1,2})\s+(%s)(?:\s+(\d{4})(?:\s?(?:г\.|года\b))?)?" % MONTH_RE, dmon, s)
    # "в ноябре 2026", "ноябрь 2026 г."
    s = re.sub(r"\b(%s)\s+(\d{4})(?:\s?(?:г\.|года\b))?(?![\d.,]\d)" % MONTH_ANY,
               lambda m: m.group(1) + " " + ordinal(int(m.group(2)), "gen") + " года", s)
    return s


def _times(s):
    def tm(m):
        h, mi, sec = int(m.group(1)), m.group(2), m.group(3)
        c = case_from_prep(_prev_word(s, m.start()), h)
        out = cardinal(h, c)
        out += " ноль-ноль" if mi == "00" and not sec else (" ноль " + cardinal(int(mi[1]), c, "f") if mi[0] == "0" else " " + cardinal(int(mi), c, "f"))
        if sec:
            out += " " + (cardinal(int(sec), c, "f") if sec[0] != "0" else "ноль " + cardinal(int(sec[1]), c, "f"))
        return out
    return re.sub(r"(?<![\d.,:])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?![\d:])", tm, s)


def _part(p):
    return digits(p) if len(p) > 1 and p.startswith("0") else cardinal(int(p))


def _versions(s):
    def ver(m):
        pre = "версия " if m.group(1) else ""
        return pre + " точка ".join(_part(p) for p in m.group(2).split("."))
    s = re.sub(r"(?<![\w.,])([vV])?(\d+(?:\.\d+){2,})(?![\w]|\.\d)", ver, s)
    s = re.sub(r"(?<![\w.,])([vV])(\d+(?:\.\d+)?)(?![\w]|\.\d)", ver, s)
    # "GLM-5.3", "FEAT-11.4": a dotted number glued to a latin name is a version
    s = re.sub(r"(?<=[A-Za-z]-)(\d+)\.(\d+)(?![\w]|[.,]\d)", lambda m: _part(m.group(1)) + " точка " + _part(m.group(2)), s)
    # "версия 1.12", "Python 3.12": two parts after a version word or a latin name
    s = re.sub(r"((?:\b(?:версия|версии|версию|версией|релиз|релиза|релизе)|[A-Za-z][\w+#-]*)\s+)(\d+)\.(\d+)(?![\w]|[.,]\d)",
               lambda m: m.group(1) + _part(m.group(2)) + " точка " + _part(m.group(3)), s)
    return s


def _phones(s):
    def ph(m):
        raw = m.group(0)
        if sum(ch.isdigit() for ch in raw) < 10:
            return raw
        out = "плюс " if raw.startswith("+") else ""
        groups = re.findall(r"\d+", raw)
        return out + ", ".join(_part(g) for g in groups)
    return re.sub(r"(?<![\w.,])\+?\d[\d\s()\-]{8,}\d(?![\w.,]\d|\d)", ph, s)


# ------------------------------------------------------------------ ordinals in text
_ORD_SUF = {"й": ("nom", "m"), "ый": ("nom", "m"), "ий": ("nom", "m"), "я": ("nom", "f"), "ая": ("nom", "f"),
            "е": ("nom", "n"), "ое": ("nom", "n"), "ю": ("acc", "f"), "ую": ("acc", "f"),
            "го": ("gen", "m"), "ого": ("gen", "m"), "его": ("gen", "m"), "му": ("dat", "m"), "ому": ("dat", "m"),
            "ему": ("dat", "m"), "м": ("pre", "m"), "ом": ("pre", "m"), "ем": ("pre", "m"), "ым": ("ins", "m"),
            "им": ("ins", "m"), "ые": ("nom", "pl"), "ие": ("nom", "pl"), "ых": ("gen", "pl"), "их": ("gen", "pl"),
            "ой": ("gen", "f")}
_CARD_SUF = {"х": "gen", "ух": "gen", "ех": "gen", "ти": "gen", "и": "gen", "ми": "gen", "ью": "ins", "мя": "ins"}
YEAR_NOUN = {"год": ("nom", "sg"), "года": ("gen", "sg"), "году": ("pre", "sg"), "годом": ("ins", "sg"),
             "годы": ("nom", "pl"), "годов": ("gen", "pl"), "годам": ("dat", "pl"), "годами": ("ins", "pl"),
             "годах": ("pre", "pl")}
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
ORD_NOUNS = {}


def _ord_noun(sg, pl, g):
    for num, forms in (("sg", sg), ("pl", pl)):
        for c, w in zip(CASES, forms):
            ORD_NOUNS.setdefault(w, []).append((c, num, g))


_ord_noun(_t("век века веку век веком веке"), _t("века веков векам века веками веках"), "m")
_ord_noun(_t("квартал квартала кварталу квартал кварталом квартале"), _t("кварталы кварталов кварталам кварталы кварталами кварталах"), "m")
_ord_noun(_t("тысячелетие тысячелетия тысячелетию тысячелетие тысячелетием тысячелетии"), _t("тысячелетия тысячелетий тысячелетиям тысячелетия тысячелетиями тысячелетиях"), "n")
_ord_noun(_t("том тома тому том томом томе"), _t("тома томов томам тома томами томах"), "m")
_ord_noun(_t("глава главы главе главу главой главе"), _t("главы глав главам главы главами главах"), "f")
_ord_noun(_t("съезд съезда съезду съезд съездом съезде"), _t("съезды съездов съездам съезды съездами съездах"), "m")
_ord_noun(_t("раздел раздела разделу раздел разделом разделе"), _t("разделы разделов разделам разделы разделами разделах"), "m")
_ord_noun(_t("этап этапа этапу этап этапом этапе"), _t("этапы этапов этапам этапы этапами этапах"), "m")
_ord_noun(_t("часть части части часть частью части"), _t("части частей частям части частями частях"), "f")


def _noun_case(word, prev):
    opts = ORD_NOUNS.get(word.lower())
    if not opts:
        return None
    want = case_from_prep(prev)
    for o in opts:
        if o[0] == want:
            return o
    return opts[0]


def _roman(r):
    v = 0
    for a, b in zip(r, r[1:] + " "):
        x = ROMAN[a]
        v += -x if b != " " and ROMAN.get(b, 0) > x else x
    return v


def _ordinals(s):
    # year ranges with "с ... по", "от ... до"
    def yspan(m):
        p, a, conj, b, noun = m.group(1), int(m.group(2)), m.group(3), int(m.group(4)), m.group(5)
        c2 = "acc" if conj == "по" else "gen"
        out = f"{p} {ordinal(a, 'gen')} {conj} {ordinal(b, c2)}"
        if noun:
            out += " " + ("год" if c2 == "acc" else "года")
        return out
    s = re.sub(r"\b(с|со|от)\s+(1\d{3}|20\d{2}|21\d{2})\s+(по|до)\s+(1\d{3}|20\d{2}|21\d{2})(\s?(?:г\.|гг\.|год[а-я]*))?", yspan, s, flags=re.I)

    # years with a noun: "в 2026 г.", "2026 году", "в 2020–2024 гг."
    def year(m):
        a, b, noun = int(m.group(1)), m.group(2), m.group(3)
        prev = _prev_word(s, m.start())
        nl = noun.lower().rstrip(".")
        if nl in ("г", "гг"):
            c = case_from_prep(prev)
            if c == "acc" and prev in LOC_P:
                c = "pre"
            if prev == "" and re.search(r"(?:%s)\s*$" % MONTH_RE, s[:m.start()]):
                c = "gen"
            num = "pl" if (nl == "гг" or b) else "sg"
        else:
            c, num = YEAR_NOUN[nl]
            if c == "pre" and prev in DAT_P:
                c = "dat"
        nw = (YEAR.sg[_C[c]] if num == "sg" else YEARS_PL[_C[c]])
        if b:
            return f"{ordinal(a, c)}-{ordinal(int(b), c)} {nw}"
        return f"{ordinal(a, c)} {nw}"
    s = re.sub(r"(?<![\d.,])(1\d{3}|20\d{2}|21\d{2})(?:\s?[–—-]\s?(1\d{3}|20\d{2}|21\d{2}))?\s?(гг\.|г\.|г(?=[\s,;:!?)]|$)|(?:год|года|году|годом|годы|годов|годам|годами|годах)\b)", year, s)
    # bare year after a preposition at a phrase end: "в 2026." -> "в две тысячи двадцать шестом."
    s = re.sub(r"\b(в|во|с|до|после|к|от)\s+(19\d{2}|20\d{2})(?=\s*(?:[.,;:!?)]|$|и\s|или\s))",
               lambda m: m.group(1) + " " + ordinal(int(m.group(2)), {"acc": "pre"}.get(case_from_prep(m.group(1).lower()), case_from_prep(m.group(1).lower()))), s)

    # roman numerals with a noun: "XXI век", "в XIX–XX вв."
    def rom(m):
        a, b, noun = m.group(1), m.group(2), m.group(3)
        prev = _prev_word(s, m.start())
        nl = noun.lower()
        if nl in ("в.", "вв."):
            c = case_from_prep(prev)
            if c == "acc" and prev in LOC_P:
                c = "pre"
            num = "pl" if (nl == "вв." or b) else "sg"
            nw = ("век века веку век веком веке" if num == "sg" else "века веков векам века веками веках").split()[_C[c]]
            g = "m"
        else:
            o = _noun_case(nl, prev)
            if not o:
                return m.group(0)
            c, num, g = o
            nw = noun
        if b:
            return f"{ordinal(_roman(a), c, g)}-{ordinal(_roman(b), c, g)} {nw}"
        return f"{ordinal(_roman(a), c, g if num == 'sg' else 'pl')} {nw}"
    s = re.sub(r"\b([IVXLC]{1,7})(?:\s?[–—-]\s?([IVXLC]{1,7}))?\s+(вв\.|в\.|[а-яё]+)", rom, s)

    # Q1-Q4
    def quarter(m):
        prev = _prev_word(s, m.start())
        c = case_from_prep(prev)
        if c == "acc" and prev in LOC_P:
            c = "pre"
        out = ordinal(int(m.group(1)), c) + " " + "квартал квартала кварталу квартал кварталом квартале".split()[_C[c]]
        if m.group(2):
            out += " " + ordinal(int(m.group(2)), "gen") + " года"
        return out
    s = re.sub(r"\bQ([1-4])(?:\s?['’]?(20\d{2}))?\b", quarter, s)

    # "5-й", "3-го", "1990-е", "90-х", "3-х", "10-летний"
    def suf(m):
        n, sfx = int(m.group(1)), m.group(2).lower()
        prev = _prev_word(s, m.start())
        if n >= 10 and n % 10 == 0 and sfx in ("е", "х", "м", "ми", "ые", "ых", "ым", "ыми"):
            c = {"е": "nom", "ые": "nom", "х": "gen", "ых": "gen", "м": "dat", "ым": "dat", "ми": "ins", "ыми": "ins"}[sfx]
            if c in ("nom", "gen") and (prev in LOC_P or prev in PRE_P):
                c = "acc" if c == "nom" else "pre"
            return ordinal(n, c, "pl")
        if sfx in _CARD_SUF:
            return cardinal(n, _CARD_SUF[sfx])
        if sfx in _ORD_SUF:
            c, g = _ORD_SUF[sfx]
            nxt = _next_words(s, m.end(), 1)
            if sfx in ("м", "ом", "ем") and prev not in LOC_P and prev not in PRE_P:
                c = "ins"
            if sfx == "ой" and (n % 10 in (2, 6, 7, 8) or n % 100 == 40) and prev not in LOC_P | PRE_P | GEN_P | DAT_P:
                c, g = "nom", "m"
            elif sfx == "ой" and (prev in LOC_P or prev in PRE_P):
                c = "pre"
            if sfx in ("й",) and (prev in LOC_P or prev in PRE_P) and nxt and nxt[0].endswith(("е", "и")):
                c, g = "pre", "f"
            if sfx == "е" and nxt and nxt[0].endswith(("ы", "и")) and not nxt[0].endswith("ие"):
                g = "pl"
            return ordinal(n, c, g)
        # compound adjective: "10-летний" -> "десятилетний"; a noun: "401-перехват" -> "401 перехват"
        if m.group(2).lower().endswith(("ый", "ий", "ой", "ая", "яя", "ое", "ее", "ые", "ие", "ых", "их", "ым", "им",
                                        "ую", "ого", "его", "ому", "ыми", "ими")):
            return compound(n) + m.group(2)
        return m.group(1) + " " + m.group(2)
    s = re.sub(r"(?<![\w.,])(\d+)\s?-\s?([а-яё]+)(?![\w])", suf, s)
    return s


# ------------------------------------------------------------------ numbers
_NUM = r"\d+(?:[.,]\d+)?"
_NUM_RE = re.compile(r"(?<![\w.,:\\])(?:(?P<pre>[$€£¥₽₸])\s?)?(?P<a>%s)(?:\s?(?P<dash>[–—-])\s?(?P<b>%s))?" % (_NUM, _NUM))
_MULT_RE = re.compile(r"\s?(?P<m>тыс\.?|млн\.?|млрд\.?|трлн\.?)(?![%s\w])|(?P<k>[kK])(?![\w])" % CYR)


def _match_unit(s, pos):
    m = re.match(r"\s?", s[pos:])
    p = pos + m.end()
    for key in _UNIT_KEYS:
        if s.startswith(key, p):
            end = p + len(key)
            nxt = s[end:end + 1]
            if key[-1].isalnum() and nxt and (nxt.isalnum() or nxt in "²³"):
                continue
            if (key in _STRICT or (len(key) == 1 and key.isalpha())) and p != pos:
                rest = s[end:end + 3]
                if key in ("с", "В", "h", "т") and not re.match(r"(?:$|[.,;:!?)\s]*$|[,;:!?)]|\.(?:\s|$)|\s+[^%sA-Za-z])" % CYR, rest):
                    continue
                if key == "т" and re.match(r"\.\s?[едпкн]\.", s[end:end + 4]):
                    continue
            return UNIT_ALIASES[key], end
    return None, pos


def _numbers(s):
    out = []
    pos = 0
    while True:
        m = _NUM_RE.search(s, pos)
        if not m:
            break
        a, b, pre = m.group("a"), m.group("b"), m.group("pre")
        end = m.end()
        mult = None
        mm = _MULT_RE.match(s, end)
        if mm:
            mult = MULTS.get(mm.group("m") or "") or (THOUSAND if mm.group("k") else None)
            end = mm.end()
        unit, uend = _match_unit(s, end)
        nxtc = s[uend if unit else end: (uend if unit else end) + 1]
        if unit is None and nxtc and re.match(r"[A-Za-z\d]", nxtc):
            out.append(s[pos:m.end()])
            pos = m.end()
            continue
        start = m.start()
        prev = _prev_word(s, start)
        cur = CUR_PRE.get(pre) if pre else None
        last = b or a
        agree_n, frac = amount_agree(last)
        deg = unit is not None and unit in (UNIT_ALIASES["°"], UNIT_ALIASES["°C"], UNIT_ALIASES["°F"])
        if mult is not None:
            c = case_from_prep(prev, agree_n)
            g = mult.g
            words = (amount(a, c, g) + "-" if b else "") + amount(last, c, g) + " " + mult.form(agree_n, c, frac)
            noun = cur or unit  # "3,75 млн ₽" -> "... миллиона рублей", "5 тыс. км" -> "... тысяч километров"
            if noun is not None:
                words += " " + noun.form(5, c)
            if unit is not None:
                end = uend
                if _end_dot(s, uend):
                    words += "."
            out.append(s[pos:start] + words)
            pos = end
            continue
        if unit is not None or cur is not None:
            noun = unit if unit is not None else cur
            c = case_from_prep(prev, agree_n)
            if c == "acc" and prev in ("в", "во") and id(noun) in _DIST:
                c = "pre"
            g = noun.g
            sub = SUBUNIT.get(id(noun))
            if sub and not b and re.fullmatch(r"\d+[.,]\d\d", last):
                ip, fp = re.split(r"[.,]", last)
                words = cardinal(int(ip), c, g) + " " + noun.form(int(ip), c)
                if int(fp):
                    words += " " + cardinal(int(fp), c, sub.g) + " " + sub.form(int(fp), c)
            else:
                words = (amount(a, c, g, deg) + "-" if b else "") + amount(last, c, g, deg) + " " + noun.form(agree_n, c, frac)
            if unit is not None and _end_dot(s, uend):
                words += "."
            out.append(s[pos:start] + words)
            pos = uend if unit is not None else end
            continue
        words_after = _next_words(s, end)
        c = case_from_context(prev, words_after, agree_n, frac)
        g = gender_from_words(words_after, agree_n, c, frac)
        if b:
            words = amount(a, c, g) + "-" + amount(b, c, g)
        else:
            words = amount(a, c, g)
        out.append(s[pos:start] + words)
        pos = end
    out.append(s[pos:])
    return "".join(out)


def _pre_numbers(s):
    # thousands separators: "1 000 000" -> "1000000"
    s = re.sub(r"(?<![\d.,])(\d{1,3})((?:[ \u00a0\u202f]\d{3})+)(?![\d]|[.,]\d)", lambda m: m.group(1) + re.sub(r"\s", "", m.group(2)), s)
    # signs and approximations
    s = re.sub(r"(?:(?<=^)|(?<=[\s(]))[~≈]\s?(?=\d)", "примерно ", s)
    s = re.sub(r"(?:(?<=^)|(?<=[\s(]))±\s?(?=\d)", "плюс-минус ", s)
    s = re.sub(r"(?:(?<=^)|(?<=[\s(]))\+(?=\d)", "плюс ", s)
    s = re.sub(r"(?:(?<=^)|(?<=[\s(]))[−-](?=\d)", "минус ", s)
    s = s.replace("−", "-")
    # per-unit: "₽/мес.", "$/ч", "руб./шт."
    for a, b in (("мес\\.?|месяц", "в месяц"), ("год|г\\.", "в год"), ("день|сут(?:ки|\\.)?", "в день"),
                 ("нед\\.?|неделю", "в неделю"), ("ч\\.?|час", "в час"), ("мин\\.?", "в минуту"),
                 ("шт\\.?|штуку", "за штуку"), ("чел\\.?|человека", "на человека"), ("кг", "за килограмм")):
        s = re.sub(r"(?<=\S)\s?/\s?(?:%s)(?![%s\w])" % (a, CYR),
                   lambda m, b=b: " " + b + ("." if _end_dot(m.string, m.end()) else ""), s)
    # multiplication / "x2"
    s = re.sub(r"(?<![\w.,])(\d+)\s?[xх×]\s?(\d+)(?![\w.,]\d|\w)", r"\1 на \2", s)

    def times(m):
        txt = m.group(1)
        n, frac = amount_agree(txt)
        v = "" if re.search(r"(?:^|\s)[вВ]\s+$", m.string[:m.start()]) else "в "
        return v + amount(txt, "acc") + " " + TIMES.form(n, "acc", frac)
    s = re.sub(r"(?<![\w])[xх×](\d+(?:[.,]\d+)?)(?![\w.,]\d|\w)", times, s)
    s = re.sub(r"(?<![\w.,])(\d+(?:[.,]\d+)?)[xх×](?![\w])", times, s)
    # simple fractions: "3/4 тестов" -> "три из четырёх", "24/7"
    s = re.sub(r"\b24/7\b", "круглосуточно", s)

    def frac(m):
        x, y = int(m.group(1)), int(m.group(2))
        if x <= y:
            return cardinal(x, "nom") + " из " + cardinal(y, "gen")
        return cardinal(x) + " на " + cardinal(y)
    s = re.sub(r"(?<![\w.,/])(\d{1,4})/(\d{1,4})(?![\w/]|[.,]\d)", frac, s)
    return s


# ------------------------------------------------------------------ latin
LETTERS = {"a": "эй", "b": "би", "c": "си", "d": "ди", "e": "и", "f": "эф", "g": "джи", "h": "эйч", "i": "ай",
           "j": "джей", "k": "кей", "l": "эл", "m": "эм", "n": "эн", "o": "оу", "p": "пи", "q": "кью", "r": "ар",
           "s": "эс", "t": "ти", "u": "ю", "v": "ви", "w": "дабл-ю", "x": "икс", "y": "уай", "z": "зед"}
# "+" marks the stressed vowel (converted to U+0301); spelled acronyms are hyphenated.
TERMS = """
api=эй-пи-+ай json=дж+ейсон github=г+итхаб gitlab=г+итлаб git=гит python=п+айтон javascript=джаваскр+ипт
typescript=тайпскр+ипт js=джей-+эс ts=ти-+эс node=нод nodejs=н+од-джей-эс npm=эн-пи-+эм npx=эн-пи-+икс
react=ре+акт vue=вью angular=+ангуляр svelte=свелт vite=вит docker=д+окер kubernetes=куберн+етис k8s=куберн+етис
linux=л+инукс windows=в+индоус macos=мак-о-+эс ios=ай-о-+эс android=андр+оид iphone=айф+он ipad=айп+эд
safari=саф+ари chrome=хром firefox=ф+айрфокс edge=эдж google=гугл yandex=+яндекс openai=оупен-эй-+ай
claude=клод anthropic=энтр+опик gpt=джи-пи-т+и chatgpt=чат-джи-пи-т+и glm=джи-эл-+эм llm=эл-эл-+эм
ai=эй-+ай ml=эм-+эл sql=эс-кью-+эл postgresql=п+остгрес postgres=п+остгрес mysql=май-эс-кью-+эл
sqlite=эс-кью-л+айт redis=р+эдис html=эйч-ти-эм-+эл css=си-эс-+эс http=эйч-ти-ти-п+и https=эйч-ти-ти-пи-+эс
url=ю-ар-+эл pdf=пэ-дэ-+эф csv=си-эс-в+и xml=икс-эм-+эл yaml=+ямл yml=+ямл ui=ю-+ай ux=ю-+экс pr=пи-+ар
ci=си-+ай cd=си-д+и dns=ди-эн-+эс ip=ай-п+и vpn=ви-пи-+эн ssh=эс-эс-+эйч ssl=эс-эс-+эл tls=ти-эл-+эс
cpu=си-пи-+ю gpu=джи-пи-+ю ram=рам ssd=эс-эс-д+и hdd=эйч-ди-д+и usb=ю-эс-б+и wifi=вайф+ай ok=ок+ей okay=ок+ей
email=им+ейл excel=+эксель word=ворд powerpoint=п+ауэрпоинт telegram=телегр+ам whatsapp=вотс+ап zoom=зум
slack=слэк notion=н+оушен jira=дж+ира figma=ф+игма frontend=фронт+энд backend=бэк+энд deploy=депл+ой
commit=ком+ит push=пуш pull=пул merge=мёрдж branch=бранч release=рел+из build=билд debug=деб+аг log=лог
logs=л+оги prod=прод stage=стейдж staging=ст+ейджинг dev=дев test=тест tests=т+есты bug=баг fix=фикс
feature=ф+ича endpoint=+эндпоинт timeout=т+аймаут token=т+окен tokens=т+окены cache=кэш server=с+ервер
client=кл+иент script=скрипт framework=фр+еймворк piper=п+айпер whisper=в+испер opencode=оупенк+од zai=зай
sales=с+ейлз xlsx=икс-эл-эс-+икс xls=икс-эл-+эс docx=док-+икс doc=док txt=тэ-экс-т+э md=эм-д+и png=пи-эн-дж+и
jpg=дж+ейпег jpeg=дж+ейпег gif=гиф svg=эс-ви-дж+и mp3=эм-пэ-тр+и mp4=эм-пэ-чет+ыре zip=зип exe=экз+е py=пай
sh=эс-+эйч ps1=пи-эс-од+ин bat=бат env=энв ini=+ини toml=томл lock=лок wav=вав ogg=огг webm=веб-+эм
pptx=пи-пи-ти-+икс ppt=пи-пи-т+и rar=рар tar=тар gz=джи-з+ед mov=мов avi=ав+и heic=х+ейк webp=в+ебпи
mobile=м+обайл web=веб app=эп apps=эпс online=онл+айн offline=офл+айн login=лог+ин logout=лога+ут
password=п+ассворд user=+юзер users=+юзеры admin=адм+ин dashboard=д+эшборд workflow=в+оркфлоу
pipeline=п+айплайн roadmap=р+оудмэп feedback=ф+идбэк deadline=д+едлайн meeting=м+итинг call=колл team=тим
lead=лид sprint=спринт scrum=скрам agile=+эджайл startup=ст+артап kpi=кей-пи-+ай roi=ар-оу-+ай b2b=би-ту-б+и
b2c=би-ту-с+и crm=си-ар-+эм erp=и-ар-п+и seo=с+ео smm=эс-эм-+эм hr=эйч-+ар it=ай-т+и pro=про max=макс
mini=м+ини plus=плюс openspec=оупенсп+ек playwright=пл+эйрайт cloudflare=кл+аудфлэр nginx=энджин+икс
ubuntu=уб+унту debian=деб+иан macbook=макб+ук apple=эпл microsoft=майкрос+офт amazon=+амазон
aws=эй-дабл-ю-+эс azure=+ажур vercel=в+ерсель supabase=с+упабейс firebase=ф+айрбейс stripe=страйп
paypal=пэйп+ал youtube=ют+уб tiktok=тикт+ок instagram=инстагр+ам vk=вэ-к+а ozon=оз+он wildberries=в+айлдберриз
avito=ав+ито readme=ридм+и todo=ту-д+у faq=эф-эй-кь+ю id=ай-д+и ids=ай-д+и uuid=ю-ю-ай-д+и os=о-+эс
sdk=эс-ди-к+ей cli=си-эл-+ай ide=ай-ди-+и vscode=ви-эс-к+од qa=кью-+эй mvp=эм-ви-п+и tts=ти-ти-+эс stt=эс-ти-т+и
asr=эй-эс-+ар nlp=эн-эл-п+и rag=раг mcp=эм-си-п+и lte=эл-ти-+и sni=эс-эн-+ай vps=ви-пи-+эс arm=арм
sherpa=ш+ерпа onnx=+оникс gigaam=г+ига-+эй-эм
openrouter=оупенр+аутер gemini=дж+емини grok=грок mistral=мистр+аль llama=л+ама qwen=квен deepseek=дипс+ик
ollama=ол+ама hugging=х+аггинг face=фейс huggingface=х+аггинг-фейс silero=сил+еро espeak=+и-спик
iso=+исо ux/ui=ю-экс-ю-+ай b2g=би-ту-дж+и ceo=си-и-+оу cto=си-ти-+оу pm=пи-+эм cv=си-в+и wiki=в+ики
plan=план free=фри premium=пр+емиум e2e=и-ту-+и feat=фит src=сорс tv=ти-в+и
"""
TERMS = {k: _stress_mark(v) for k, v in (x.split("=", 1) for x in TERMS.split())}
SPECIAL = [
    (r"(?<![\w])C\+\+(?![\w])", "си-плюс-плюс"), (r"(?<![\w])C#(?![\w])", "си-шарп"), (r"(?<![\w])F#(?![\w])", "эф-шарп"),
    (r"(?<![\w])\.NET\b", "дотн+ет"), (r"\bNode\.js\b", "н+од-джей-эс"), (r"\bNext\.js\b", "некст-джей-+эс"),
    (r"\bVue\.js\b", "вью-джей-+эс"), (r"\b[Ww]i-?[Ff]i\b", "вайф+ай"), (r"\b[Ee]-mail\b", "им+ейл"),
    (r"\bA/B\b", "эй-б+и"), (r"\bUX/UI\b|\bUI/UX\b", "ю-ай ю-+экс"), (r"\bTCP/IP\b", "ти-си-пи ай-п+и"),
    (r"\bI/O\b", "ай-+оу"), (r"\bQ&A\b", "кью-энд-+эй"), (r"\bR&D\b", "ар-энд-д+и"), (r"\bAT&T\b", "эй-ти-энд-т+и"),
]
SPECIAL = [(re.compile(p), _stress_mark(r)) for p, r in SPECIAL]
EXT = ("xlsx|xls|docx|doc|pptx|ppt|pdf|txt|md|csv|json|yaml|yml|xml|html|css|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|bat|"
       "exe|zip|rar|tar|gz|png|jpg|jpeg|gif|svg|webp|heic|mp3|mp4|wav|ogg|webm|mov|avi|env|ini|toml|lock|log|sql|db|"
       "onnx|apk|ipa|dmg|msi|iso")
TLD = {"ru": "ру", "com": "ком", "org": "орг", "net": "нет", "io": "ай-+оу", "dev": "дев", "ai": "эй-+ай",
       "рф": "эр-+эф", "app": "эп", "me": "ми", "su": "эс-+ю", "info": "+инфо", "tech": "тек", "cloud": "клауд"}
TLD = {k: _stress_mark(v) for k, v in TLD.items()}

_IPA = [("tʃ", "ч"), ("dʒ", "дж"), ("eɪ", "эй"), ("aɪ", "ай"), ("ɔɪ", "ой"), ("aʊ", "ау"), ("oʊ", "оу"), ("əʊ", "оу"),
        ("ɪə", "иа"), ("eə", "эа"), ("ʊə", "уа"), ("iː", "и"), ("uː", "у"), ("ɑː", "а"), ("ɔː", "о"), ("ɜː", "ё"),
        ("ɚ", "эр"), ("ɝ", "ёр"), ("p", "п"), ("b", "б"), ("t", "т"), ("d", "д"), ("k", "к"), ("ɡ", "г"), ("g", "г"),
        ("f", "ф"), ("v", "в"), ("θ", "с"), ("ð", "з"), ("s", "с"), ("z", "з"), ("ʃ", "ш"), ("ʒ", "ж"), ("h", "х"),
        ("m", "м"), ("n", "н"), ("ŋ", "нг"), ("l", "л"), ("ɹ", "р"), ("r", "р"), ("j", "й"), ("w", "у"), ("ɾ", "т"),
        ("x", "х"), ("i", "и"), ("ɪ", "и"), ("ᵻ", "и"), ("e", "э"), ("ɛ", "э"), ("æ", "э"), ("a", "а"), ("ɑ", "а"),
        ("ɒ", "о"), ("ɔ", "о"), ("o", "о"), ("ʊ", "у"), ("u", "у"), ("ʌ", "а"), ("ə", "э"), ("ɐ", "а"), ("ɜ", "ё")]
_VOW = set("аеёиоуыэюя")
_espeak = None


def _espeak_en(word):
    global _espeak
    if _espeak is None:
        try:
            from piper import espeakbridge
            from piper.phonemize_espeak import ESPEAK_DATA_DIR
            espeakbridge.initialize(str(ESPEAK_DATA_DIR))
            _espeak = espeakbridge
        except Exception:
            _espeak = False
    if not _espeak:
        return None
    _espeak.set_voice("en-us")
    try:
        return "".join(p for p, _t2, _e in _espeak.get_phonemes(word))
    finally:
        _espeak.set_voice("ru")


_TRANSLIT = {"a": "а", "b": "б", "c": "к", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х", "i": "и", "j": "дж",
             "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "q": "к", "r": "р", "s": "с", "t": "т",
             "u": "у", "v": "в", "w": "в", "x": "кс", "y": "и", "z": "з"}


@lru_cache(maxsize=4096)
def ipa_word(word):
    ph = _espeak_en(word)
    if not ph:
        return "".join(_TRANSLIT.get(ch, "") for ch in word.lower())
    out = []
    stress = False
    i = 0
    while i < len(ph):
        ch = ph[i]
        if ch == "ˈ":
            stress = True
            i += 1
            continue
        if ch in "ˌːʲ'\"" or ch == " ":
            i += 1 if ch != " " else 0
            if ch == " ":
                out.append(" ")
                i += 1
            continue
        for k, v in _IPA:
            if ph.startswith(k, i):
                if stress and v and v[0] in _VOW:
                    out.append("+" + v)
                    stress = False
                else:
                    out.append(v)
                i += len(k)
                break
        else:
            i += 1
    s = "".join(out)
    s = re.sub(r"й\+?у", lambda m: "+ю" if "+" in m.group(0) else "ю", s)
    s = re.sub(r"й\+?э", lambda m: "+е" if "+" in m.group(0) else "е", s)
    s = re.sub(r"й\+?а", lambda m: "+я" if "+" in m.group(0) else "я", s)
    if sum(ch in _VOW for ch in s) < 2:
        s = s.replace("+", "")
    return _stress_mark(s)


def spell(word, stress=False):
    parts = [LETTERS.get(ch, ch) for ch in word.lower()]
    if stress and len(parts) > 1:
        m = re.search("[аеёиоуыэюя]", parts[-1])
        if m:
            parts[-1] = parts[-1][:m.end()] + ACUTE + parts[-1][m.end():]
    return "-".join(parts)


def latin_word(w):
    lw = w.lower()
    if lw in TERMS:
        return TERMS[lw]
    if len(w) == 1:
        return LETTERS.get(lw, w)
    if (w.isupper() and len(w) <= 5) or (not re.search(r"[aeiouy]", lw) and len(w) <= 5):
        return spell(w, True)
    return ipa_word(lw)


def _latin_token(tok):
    # "GPT-4o", "N150", "mp3", "x86" -> runs of letters / digits
    lt = tok.lower()
    if lt in TERMS:
        return TERMS[lt]
    parts = []
    for run in re.findall(r"[A-Za-z]+|\d+", tok):
        parts.append(cardinal(int(run)) if run.isdigit() and not run.startswith("0") else (digits(run) if run.isdigit() else latin_word(run)))
    return " ".join(parts)


def _latin(s):
    for rx, rep in SPECIAL:
        s = rx.sub(rep, s)
    # paths -> the file name
    s = re.sub(r"(?<![\w])(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}[\\/]?", lambda m: " " + re.split(r"[\\/]", m.group(0).rstrip("\\/"))[-1] + " ", s)

    def fname(m):
        name, ext = m.group(1), m.group(2)
        read = " ".join(_latin_token(p) if re.search(r"[A-Za-z]", p) else (p if re.search("[%s]" % CYR, p) else _latin_token(p))
                        for p in re.split(r"[._-]+", name) if p)
        return read + " точка " + TERMS.get(ext.lower(), spell(ext, True))
    s = re.sub(r"(?<![\w.])([\w-]+(?:\.[\w-]+)*)\.(%s)\b" % EXT, fname, s, flags=re.I)

    def domain(m):
        parts = m.group(1).split(".")
        return " точка ".join(_latin_token(p) if re.search(r"[A-Za-z0-9]", p) else p for p in parts) + " точка " + TLD[m.group(2).lower()]
    s = re.sub(r"(?<![\w.@])((?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+)\.(%s)\b(?!\.\w)" % "|".join(TLD), domain, s)
    s = re.sub(r"(?<![\w])@(?=[A-Za-z])", "", s)
    s = re.sub(r"(?<=\w)_(?=\w)", " ", s)
    s = re.sub(r"\b\d+[A-Za-z][A-Za-z0-9]*\b", lambda m: _latin_token(m.group(0)), s)
    s = re.sub(r"(?<![%s])\b[A-Za-z][A-Za-z0-9]*(?:['’][A-Za-z]+)?(?:-[A-Za-z0-9]+)*\b" % CYR,
               lambda m: " ".join(_latin_token(p) for p in m.group(0).replace("’", "'").split("-")), s)
    return s


# ------------------------------------------------------------------ symbols, pauses, cleanup
def _symbols(s):
    s = re.sub(r"\s+&\s+|(?<=\w)&(?=\w)", " и ", s)
    s = re.sub(r"\s*\+\s*", " плюс ", s)
    s = re.sub(r"\s+=\s+|(?<=\w)=(?=\w)", " равно ", s)
    s = re.sub(r"\s+≈\s+", " примерно ", s)
    s = re.sub(r"\s+<=\s+|\s*≤\s*", " не больше ", s)
    s = re.sub(r"\s+>=\s+|\s*≥\s*", " не меньше ", s)
    s = re.sub(r"\s+<\s+", " меньше ", s)
    s = re.sub(r"\s+>\s+", " больше ", s)
    s = re.sub(r"\s*≠\s*", " не равно ", s)
    s = re.sub(r"(?<=[%s])/(?=[%s])" % (CYR, CYR), " или ", s)
    s = re.sub(r"\s*\|\s*", ", ", s)
    s = re.sub(r"\s*[•·]\s*", ", ", s)
    s = s.replace("§", " параграф ").replace("%", " процентов").replace("$", " долларов").replace("€", " евро")
    s = s.replace("₽", " рублей").replace("°", " градусов").replace("№", " номер ")
    s = re.sub(r"[©®™^\\{}\[\]<>#~@]", " ", s)
    s = re.sub(r"\s*\(\s*", ", ", s)
    s = re.sub(r"\s*\)\s*", ", ", s)
    s = re.sub(r"\s+[-–]\s+", " — ", s)
    s = re.sub(r"(?<=[%s])/(?=\s)|(?<=\s)/(?=[%s])" % (CYR, CYR), " ", s)
    s = s.replace("/", " ")
    return s


def _tidy(s):
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([,.;:!?…])", r"\1", s)
    s = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", s)
    s = re.sub(r"[,;:]\s*([.!?])", r"\1", s)
    s = re.sub(r"([.!?])\s*[,;:]", r"\1", s)
    s = re.sub(r"—\s*[,]", "—", s)
    s = re.sub(r",\s*—", " —", s)
    s = re.sub(r"(?:—\s*){2,}", "— ", s)
    s = re.sub(r"\.{4,}", "...", s)
    s = re.sub(r"(?<!\.)\.\.(?!\.)", ".", s)
    s = re.sub(r"^[\s,.;:—–-]+", "", s)
    s = re.sub(r"(?<=[.!?…])\s+([а-яёa-z])", lambda m: " " + m.group(1).upper(), s)
    s = re.sub(r"([,;:])(?=[^\s\d])", r"\1 ", s)
    if s and s[0].islower():
        s = s[0].upper() + s[1:]
    return s.strip()


# ------------------------------------------------------------------ ё and stress
class StressDict:
    def __init__(self, path):
        self.db = None
        if path and os.path.isfile(path):
            try:
                self.db = sqlite3.connect("file:%s?mode=ro" % path.replace("\\", "/"), uri=True, check_same_thread=False)
            except sqlite3.Error:
                self.db = None

    def fem(self, word):
        """True / False when the lexicon knows the word form, None without the table."""
        if not self.db:
            return None
        try:
            return self.db.execute("select 1 from g where k = ?", (word,)).fetchone() is not None
        except sqlite3.Error:
            return None

    def lookup(self, words):
        if not self.db or not words:
            return {}
        words = list(words)
        out = {}
        for i in range(0, len(words), 400):
            chunk = words[i:i + 400]
            q = "select k, f from w where k in (%s)" % ",".join("?" * len(chunk))
            out.update(dict(self.db.execute(q, chunk).fetchall()))
        return out


_INF = ("ть", "ти", "чь", "ться", "тись")
_NUMERALS = {w for t in (ZERO, *ONE.values(), *TWO.values(), *UNITS.values(), *TEENS.values(), *TENS.values(),
                         *HUNDREDS.values()) for w in t} | {"тысяча", "тысячу", "миллион", "полтора", "полторы", "около"}
_WORD = re.compile(r"[%s\u0301]+" % CYR)  # a word that already has a mark is left as is


def _context_rules(words, i):
    """-> replacement (with '+' stress) for words[i] or None. words: list of (word, gap_after)."""
    w = words[i][0]
    lw = w.lower()
    prev = words[i - 1][0].lower() if i > 0 else ""
    gap = words[i][1]
    nxt = words[i + 1][0].lower() if i + 1 < len(words) else ""
    if lw == "все":
        if i + 1 >= len(words) or re.match(r"\s*[.!?;:—]", gap):
            return "всё"
        if gap.strip().startswith(","):
            return "всё" if nxt in ("что", "чем") else None
        if prev in ("мы", "вы", "они", "нас", "вас", "их", "им", "нам", "вам"):
            return None
        if nxt in ("ещё", "еще", "равно", "же", "таки", "время", "это", "так", "понятно", "готово", "хорошо",
                   "нормально", "верно", "правильно", "сделано", "работает", "ок", "окей", "получилось", "было",
                   "будет", "есть", "сходится", "прошло", "просто", "сразу", "что", "в", "по", "под", "на",
                   "уже", "сам", "само", "сама", "стало", "отлично", "супер", "чисто", "понял", "подряд"):
            if nxt in ("в", "на", "по", "под") and not re.match(r"\s*(?:в\s+порядке|по\s+плану|на\s+месте|под\s+контролем)", gap + " ".join(x[0] for x in words[i + 1:i + 3])):
                return None
            return "всё"
        if nxt.endswith(("ет", "ёт", "ит", "ло", "лось")) and not nxt.endswith(("ают", "уют")):
            return "всё"
        return None
    if lw == "уже" and prev not in ("ещё", "еще", "гораздо", "намного", "чуть", "немного", "значительно"):
        return "уж+е"
    if lw == "стоит" and (nxt.endswith(_INF) or nxt in _NUMERALS or prev in ("не", "сколько", "того", "это", "дорого", "дёшево", "недорого") or nxt == "ли"):
        return "ст+оит"
    if lw in ("чем", "чему") and prev in ("о", "при", "в", "на") and lw == "чем":
        return "чём"
    if lw == "всем" and prev in ("во", "обо", "при", "на"):
        return "всём"
    if lw == "перед":
        return "п+еред"
    if lw == "замок":
        ctx = " ".join(x[0].lower() for x in words[max(0, i - 3):i + 4])
        if re.search(r"двер|ключ|закр|откр|кодов|навесн|щеколд|сломал|повес", ctx):
            return "зам+ок"
        if re.search(r"стари|средневек|корол|рыцар|песочн|башн|замке|дворец|крепост", ctx):
            return "з+амок"
    return None


def _recase(orig, form):
    if orig[:1].isupper():
        return form[:1].upper() + form[1:]
    return form


def stress(s, sd):
    toks = list(_WORD.finditer(s))
    if not toks:
        return s
    words = [(m.group(0), s[m.end(): toks[i + 1].start()] if i + 1 < len(toks) else s[m.end():]) for i, m in enumerate(toks)]
    look = {m.group(0).lower() for m in toks if ACUTE not in m.group(0) and not (m.group(0).isupper() and len(m.group(0)) > 1)}
    found = sd.lookup(look) if sd else {}
    out = []
    pos = 0
    for i, m in enumerate(toks):
        w = m.group(0)
        rep = None if ACUTE in w else _context_rules(words, i)
        if rep is None and ACUTE not in w and not (w.isupper() and len(w) > 1):
            f = found.get(w.lower())
            if f:
                rep = f
        out.append(s[pos:m.start()])
        out.append(_recase(w, rep) if rep else w)
        pos = m.end()
    out.append(s[pos:])
    return _stress_mark("".join(out))


# ------------------------------------------------------------------ entry point
_SD = None


def stress_dict(models=None):
    global _SD
    if _SD is None:
        models = models or os.environ.get("ZAI_VOICE_MODELS", r"D:\Voice\models")
        _SD = StressDict(os.path.join(models, "ru-stress", "ru_stress.db"))
    return _SD


def normalize(text, sd=None, accents=True):
    s = str(text or "")
    if not s.strip():
        return ""
    s = _cleanup(s)
    s = _abbr(s, ABBR_EARLY)
    s = _phones(s)
    s = _dates(s)
    s = _times(s)
    s = _versions(s)
    s = _ordinals(s)
    s = _pre_numbers(s)
    s = _numbers(s)
    s = _abbr(s, ABBR_LATE)
    s = _latin(s)
    s = _symbols(s)
    s = _tidy(s)
    s = _stress_mark(s) if not accents else stress(s, sd if sd is not None else stress_dict())
    return s
