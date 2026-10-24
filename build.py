"""Сборка статического сайта подписатьэцп.рф в папку site/.

python3 build.py
"""
import hashlib
import json
import os
import shutil

from jinja2 import Environment, FileSystemLoader

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
OUT = os.path.join(ROOT, "site")
FILES = os.path.join(ROOT, "files")  # большие файлы: Help4x и исходники
VERSION = "1"

ICONS = {
    "egais": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8l-1 6a4 4 0 0 1-6 0z"/><path d="M12 13v8M8 21h8"/></svg>',
    "mercury": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 7l2-3h12l2 3"/><path d="M9 13l2 2 4-4"/></svg>',
    "reports": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
}

SOON = {
    "egais": dict(
        page_title="ЕГАИС",
        lead="Работа с ЕГАИС прямо в браузере через ваш УТМ — без платных подписок.",
        plan=[
            "Входящие накладные: просмотр, «Принять» и «Отказать»",
            "Остатки по складу и торговому залу",
            "Списание, в том числе маркированного алкоголя — марки подтягиваются из остатков",
            "Уведомления о новых накладных и об окончании срока ключа",
        ],
    ),
    "mercury": dict(
        page_title="Меркурий",
        lead="Гашение ветеринарных документов на молочку, мясо и рыбу — рядом с накладными ЕГАИС.",
        plan=[
            "Список входящих ВСД",
            "Гашение в один клик или автоматически",
            "Подсказки, как получить доступ к API Меркурия",
        ],
    ),
    "reports": dict(
        page_title="Алкогольная отчётность",
        lead="Декларации и отчёты по алкоголю с подписью прямо на сайте.",
        plan=[
            "Декларации ФСРАР по формам 7 и 8: загрузить готовую или собрать из накладных ЕГАИС",
            "Подпись и подготовка файла для service.fsrar.ru",
            "Ежемесячный отчёт в Госалкогольинспекцию РТ — архив с подписью для отправки по почте",
        ],
    ),
}


def fmt_size(n):
    return f"{n / 1024 / 1024:.1f} МБ".replace(".", ",")


def help4x_info():
    meta_path = os.path.join(FILES, "help4x.json")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    exe = os.path.join(FILES, meta["file"])
    src = os.path.join(FILES, meta["source"])
    h = hashlib.sha256()
    with open(exe, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    meta.update(size=fmt_size(os.path.getsize(exe)), sha256=h.hexdigest(),
                source_size=fmt_size(os.path.getsize(src)))
    return meta


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(os.path.join(SRC, "static"), os.path.join(OUT, "static"))
    os.makedirs(os.path.join(OUT, "files"))
    for name in os.listdir(FILES):
        if name != "help4x.json":
            shutil.copy2(os.path.join(FILES, name), os.path.join(OUT, "files", name))

    env = Environment(loader=FileSystemLoader(os.path.join(SRC, "templates")), autoescape=True)
    common = dict(version=VERSION)
    pages = {
        "index": dict(tpl="index.html", page_title="Электронная подпись и ЕГАИС бесплатно", active="",
                      description="Подписать файл электронной подписью в браузере — Рутокен и КриптоПро. ЕГАИС, Меркурий, алкогольная отчётность."),
        "sign": dict(tpl="sign.html", page_title="Подписать файл", active="sign",
                     description="Подписать файл электронной подписью ГОСТ в браузере: Рутокен Плагин или КриптоПро. Архив с подписью .sig, как у КриптоАРМ."),
        "help4x": dict(tpl="help4x.html", page_title="Удалённая помощь Help4x", active="help4x",
                       description="Программа удалённой помощи Help4x: поможем настроить подпись, УТМ и плагины.",
                       h4x=help4x_info()),
        "about": dict(tpl="about.html", page_title="О проекте", active="",
                      description="О проекте подписатьэцп.рф"),
    }
    for key, data in SOON.items():
        pages[key] = dict(tpl="soon.html", active=key, icon=ICONS[key],
                          description=data["lead"], **data)
    for name, ctx in pages.items():
        html = env.get_template(ctx.pop("tpl")).render(**common, **ctx)
        with open(os.path.join(OUT, name + ".html"), "w", encoding="utf-8") as f:
            f.write(html)
    print("Собрано в", OUT, "страниц:", len(pages))


if __name__ == "__main__":
    main()
