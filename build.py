"""Сборка статического сайта подписатьэцп.рф в папку site/.

python3 build.py
"""
import hashlib
import json
import os
import shutil
from datetime import date

from jinja2 import Environment, FileSystemLoader

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
OUT = os.path.join(ROOT, "site")
FILES = os.path.join(ROOT, "files")  # большие файлы: Help4x и исходники
VERSION = "25"
PHONE = "+7 (843) 208-53-54"
PHONE_TEL = "+78432085354"
SITE = "https://xn--80ahmweccok4b0dm.xn--p1ai"  # подписатьэцп.рф

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
            "Частичная приёмка — когда пришло не столько, сколько в накладной",
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


FAQ = [
    ("Как подписать файл электронной подписью бесплатно?",
     "Выберите файл на этой странице, выберите свою подпись (Рутокен или КриптоПро) и нажмите «Подписать». "
     "Сайт бесплатный, регистрация не нужна — нужен только бесплатный плагин для браузера."),
    ("Нужен ли КриптоАРМ, чтобы получить файл .sig?",
     "Нет. Сайт делает такую же отделённую подпись .sig в формате CMS по ГОСТ Р 34.10-2012 и упаковывает её "
     "в архив .zip вместе с исходным файлом — так же, как КриптоАРМ и СБИС."),
    ("Подойдёт ли подпись, полученная в налоговой (ФНС)?",
     "Да. Подпись из налоговой обычно записана на Рутокен ЭЦП 3.0 — для неё достаточно бесплатного Рутокен Плагина. "
     "Подписи, которые работают через КриптоПро CSP, тоже подходят."),
    ("Для чего нужен файл подписи .sig?",
     "Его просят приложить, когда документ отправляют в госорган или контрагенту в электронном виде: "
     "декларации в ФСРАР, отчёты в инспекции, заявления и документы в Росреестр, «Мой арбитр», "
     "документы для торгов и договоры по почте. Подпись подходит для любых таких сервисов, не только для алкоголя."),
    ("Мой файл отправляется на сервер?",
     "Нет. Файл читается и подписывается прямо в вашем браузере, на вашем компьютере. На сервер ничего не загружается."),
]

FAQ_PDF = [
    ("Это юридически значимая подпись?",
     "Да, если подпись квалифицированная (УКЭП) — например, полученная в налоговой или в аккредитованном УЦ. "
     "Подпись встраивается в PDF по стандарту PAdES (CAdES внутри PDF), штамп — только её видимое отображение "
     "по ГОСТ Р 7.0.97-2025: «Документ подписан электронной подписью», номер сертификата, владелец и срок действия."),
    ("Есть ли в штампе реклама или название сайта?",
     "Нет. В штампе только реквизиты вашей подписи и, если хотите, ваш логотип или герб. Бесплатно и без ограничений по стилям."),
    ("Можно поставить штамп на несколько страниц?",
     "Да. Нажмите на нужные страницы или кнопку «На каждую страницу». Подпись при этом одна — штампы показывают её на каждой отмеченной странице."),
    ("Документ уже подписан другой стороной — можно подписать ещё раз?",
     "Да. Новая подпись дописывается в конец файла, прежние подписи остаются действительными. Так подписывают договор с двух сторон."),
    ("Где проверить подписанный PDF?",
     "На странице «Проверить подпись» этого сайта, в Adobe Acrobat с КриптоПро PDF, на Госуслугах и в системах документооборота."),
    ("Мой файл отправляется на сервер?",
     "Нет. Документ открывается, подписывается и сохраняется прямо в вашем браузере."),
]

FAQ_VERIFY = [
    ("Как проверить электронную подпись бесплатно?",
     "Перетащите на эту страницу подписанный PDF, или документ вместе с файлом подписи .sig, или архив .zip от КриптоАРМ и СБИС. "
     "Проверка идёт прямо в браузере, плагины и регистрация не нужны."),
    ("Какие подписи можно проверить?",
     "Подписи по ГОСТ Р 34.10-2012 в формате CMS: отделённые (.sig, .p7s) и присоединённые, а также подписи внутри PDF (PAdES). "
     "Так подписывают КриптоАРМ, СБИС, КриптоПро, Контур и этот сайт."),
    ("Что значит «Документ изменён после подписания»?",
     "Файл отличается от того, что был подписан, хотя бы на один байт: его пересохранили, отредактировали или приложили не тот документ."),
    ("Проверяется ли отзыв сертификата?",
     "Нет — для этого нужен запрос к серверу удостоверяющего центра. Целостность документа, подлинность подписи и срок действия сертификата проверяются полностью."),
]


def faq_ld(faq):
    return {
        "@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q,
                        "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq],
    }


FAQ_LD = faq_ld(FAQ)


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
    shutil.copytree(os.path.join(SRC, "root"), OUT, dirs_exist_ok=True)  # файлы подтверждения для поисковиков
    os.makedirs(os.path.join(OUT, "files"))
    for name in os.listdir(FILES):
        if name != "help4x.json":
            shutil.copy2(os.path.join(FILES, name), os.path.join(OUT, "files", name))

    env = Environment(loader=FileSystemLoader(os.path.join(SRC, "templates")), autoescape=True)
    common = dict(version=VERSION, phone=PHONE, phone_tel=PHONE_TEL, site=SITE)
    pages = {
        "index": dict(tpl="index.html", page_title="Электронная подпись и ЕГАИС бесплатно", active="",
                      description="Подписать файл электронной подписью в браузере — Рутокен и КриптоПро. ЕГАИС, Меркурий, алкогольная отчётность."),
        "sign": dict(tpl="sign.html", page_title="Подписать файл ЭЦП онлайн бесплатно", active="sign",
                     description="Подписать файл электронной подписью бесплатно прямо в браузере: Рутокен ЭЦП 3.0 из налоговой или КриптоПро. Отделённая подпись .sig и архив .zip, как у КриптоАРМ и СБИС. Без установки КриптоАРМ.",
                     faq=FAQ, faq_ld=FAQ_LD),
        "pdf": dict(tpl="pdf.html", page_title="Подписать PDF электронной подписью со штампом", active="pdf",
                    description="Подписать PDF квалифицированной электронной подписью с видимым штампом по ГОСТ Р 7.0.97 — бесплатно, без рекламы в штампе. Рутокен и КриптоПро, PAdES, несколько штампов, свой логотип.",
                    faq=FAQ_PDF, faq_ld=faq_ld(FAQ_PDF)),
        "verify": dict(tpl="verify.html", page_title="Проверить электронную подпись онлайн бесплатно", active="verify",
                       description="Проверить электронную подпись бесплатно и без плагинов: подписанный PDF, файл .sig или .p7s с документом, архив КриптоАРМ и СБИС. ГОСТ Р 34.10-2012, всё в браузере.",
                       faq=FAQ_VERIFY, faq_ld=faq_ld(FAQ_VERIFY)),
        "help4x": dict(tpl="help4x.html", page_title="Удалённая помощь Help4x", active="help4x",
                       description="Программа удалённой помощи Help4x: поможем настроить подпись, УТМ и плагины.",
                       h4x=help4x_info()),
        "about": dict(tpl="about.html", page_title="О проекте", active="",
                      description="О проекте подписатьэцп.рф"),
        "privacy": dict(tpl="privacy.html", page_title="Политика конфиденциальности", active="",
                        description="Мы не собираем ваши данные: подпись, проверка и ЕГАИС работают в вашем браузере. Без регистрации, cookie и счётчиков."),
    }
    for key, data in SOON.items():
        pages[key] = dict(tpl="egais.html" if key == "egais" else "soon.html", active=key, icon=ICONS[key],
                          description=data["lead"], **data)
    for name, ctx in pages.items():
        ctx["path"] = "/" if name == "index" else "/" + name
        html = env.get_template(ctx.pop("tpl")).render(**common, **ctx)
        with open(os.path.join(OUT, name + ".html"), "w", encoding="utf-8") as f:
            f.write(html)
    write_seo(pages)
    print("Собрано в", OUT, "страниц:", len(pages))


def write_seo(pages):
    with open(os.path.join(OUT, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(f"User-agent: *\nDisallow: /files/\n\nSitemap: {SITE}/sitemap.xml\n")
    today = date.today().isoformat()
    urls = "".join(f"  <url><loc>{SITE}{ctx['path']}</loc><lastmod>{today}</lastmod></url>\n" for ctx in pages.values())
    with open(os.path.join(OUT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "</urlset>\n")


if __name__ == "__main__":
    main()
