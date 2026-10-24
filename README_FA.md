# راهنمای بازسازی کامل mhr-cfw با خروجی Chrome روی Render

این سند برای این است که اگر همه‌چیز را فراموش کردی، از صفر و به پایدارترین شکل
همین زنجیره را بسازی: ورودی از Google (بدون فیلتر)، خروجی از Render با اثر انگشت
Chrome، و یک روتر که بین چند اکانت Render سوئیچ و فِیلاوور می‌کند.

> این نسخه بر اساس مسیر واقعی طی‌شده نوشته شده است: چیزهایی که کار کرد، چیزهایی
> که کار نکرد، و خطاهای واقعی که دیده شد. هر جا عدد یا نسخه‌ای آمده، همان چیزی
> است که در این پروژه تست شد.

---

## ۱) معماری نهایی

~~~
مرورگر / گوشی
   │  HTTP proxy 127.0.0.1:8085  (یا SOCKS5 127.0.0.1:1080)
   ▼
پروکسی محلی mhr (main.py)  ── MITM + رله JSON ──┐
   │  TLS با SNI=www.google.com به google_ip     │
   ▼                                              │
Google Apps Script (Code.gs)                      │
   │  UrlFetchApp به WORKER_URL                   │
   ▼                                              │
ورکر اصلی (deploy/cloudflare-worker/worker.js)    │
   │  POST {u,m,h,b} + x-upstream-auth            │
   ▼                                              │
Exit / Router Worker (deploy/exit-worker)  ◄──────┘
   │  انتخاب یک forwarder از استخر (sticky + failover)
   ├──► Render A (Python + curl_cffi، Chrome JA4)
   ├──► Render B (اکانت دوم)
   └──► Render C (اکانت سوم)
          │
          ▼
        سایت مقصد  →  IP خروجی: IP همان Render
~~~

نکات کلیدی:

- فیلترینگ فقط مسیر «ایران → Google» را می‌بیند. بقیه‌ی زنجیره از داخل
  Cloudflare/Google انجام می‌شود.
- ورکر اصلی به‌تنهایی IP خروجی ثابت ندارد؛ خروجی پایدار از Render می‌آید.
- Render به‌تنهایی اثر انگشت TLS مرورگر ندارد؛ Python forwarder با
  curl_cffi آن را شبیه Chrome می‌کند.
- روتر چند اکانت را مدیریت می‌کند: تا وقتی سرویس اول سالم است از آن استفاده
  می‌کند (برای حفظ IP نشست)، و فقط هنگام خطا به بعدی می‌رود.

### چرا این‌طور است؟

| لایه | مشکل | راه‌حل |
|---|---|---|
| ورودی | دامنه‌های Cloudflare و onrender از ایران بسته‌اند | ورودی Google/GAS؛ اتصال به Render از داخل Cloudflare |
| IP خروجی | fetch کلادفلر هر درخواست IP عوض می‌کند | خروجی Render (پایدار در حد نشست) |
| کپچا | TLS خروجی Node/OpenSSL است ولی UA کروم | Python forwarder با curl_cffi و پروفایل chrome |
| چند اکانت | ۵ گیگ و ۷۵۰ ساعت هر اکانت محدود است | روتر با استخر FORWARD_URLS و failover |
| خواب Render | بعد از ۱۵ دقیقه می‌خوابد | Cron Trigger هر ۱۰ دقیقه برای همه‌ی سرویس‌ها |

---

## ۲) پیش‌نیازها

| مورد | توضیح |
|---|---|
| حساب Google | برای Apps Script (رایگان) |
| حساب Cloudflare | برای دو ورکر (رایگان) |
| حساب(های) Render | برای forwarder؛ هر اکانت ۵ گیگ و ۷۵۰ ساعت در ماه |
| Python 3.10+ | روی سیستم محلی (برای پروکسی و ابزارها) |
| Chrome | برای تست نهایی و کپچا |
| اختیاری: دامنه | فقط اگر بخواهی Render را با دامنه‌ی خودت صدا بزنی؛ لازم نیست |

> محدودیت‌ها: Render رایگان ۵ گیگ خروجی در ماه و ۷۵۰ ساعت instance در ماه دارد؛
> سرویس رایگان بعد از ۱۵ دقیقه بی‌کاری می‌خوابد. Cloudflare Workers رایگان
> ۱۰۰٬۰۰۰ درخواست در روز. Google Apps Script رایگان حدود ۲۰٬۰۰۰ UrlFetch و
> ۶ دقیقه اجرا در روز. envelope پایه۶۴ حدود ۳۳٪ حجم اضافه می‌کند.

---

## ۳) انتخاب مسیر

| هدف | انتخاب |
|---|---|
| فقط عبور از فیلتر، بدون نیاز به IP ثابت | mhr با MODE=fetch (بدون Render) |
| IP پایدار + عبور از کپچای Cloudflare | Python forwarder + روتر sticky |
| فقط IP پایدار، بدون نگرانی اثر انگشت | Node forwarder (upstream_forwarder.js) |
| چند اکانت Render | روتر با FORWARD_URLS |
| IP واقعاً ثابت و مطمئن | VM با IP رزروشده (Oracle/GCP) + همان forwarder |

---

## ۴) فاز ۱ — Google Apps Script (دروازه)

1. به script.google.com برو و New project بساز.
2. کل محتوای deploy/gas/Code.gs را جای‌گذاری کن.
3. دو ثابت بالای فایل را عوض کن:

~~~js
const AUTH_KEY = "یک-رمز-تصادفی-حداقل-۳۲-کاراکتر";
const WORKER_URL = "https://newhmr.<account>.workers.dev";
~~~

4. Deploy → New deployment → Web app:
   - Execute as: Me
   - Who has access: Anyone
5. Deployment ID را کپی کن (مثل AKfycb...). این همان script_id است.

> هر بار Code.gs را عوض کردی، Deployment جدید بساز و script_id را در
> config.json به‌روز کن. خطای «upstream HTTP 404 from script ...» معمولاً یعنی
> همین Deployment مشکل دارد یا سهمیه تمام شده.

---

## ۵) فاز ۲ — ورکر اصلی (ورودی رله)

فایل: deploy/cloudflare-worker/worker.js

1. در Cloudflare → Workers & Pages → Create → Hello World.
2. کل کد worker.js را جای‌گذاری کن.
3. ثابت WORKER_URL داخل فایل را به دامنه‌ی همین ورکر عوض کن
   (فقط برای جلوگیری از self-fetch است؛ مثال:
   newhmr.<account>.workers.dev).
4. Deploy.
5. Settings → Variables and Secrets:

| متغیر | مقدار |
|---|---|
| UPSTREAM_FORWARDER_URL | آدرس روتر (Exit Worker)، مثال: https://mhr-exit.<account>.workers.dev |
| UPSTREAM_AUTH_KEY | همان RELAY_KEY روتر |
| UPSTREAM_TIMEOUT_MS | 150000 (باید از FORWARD_ATTEMPTS × FORWARD_TIMEOUT_MS بیشتر باشد) |
| UPSTREAM_FAIL_MODE | closed برای دیدن خطاها؛ open فقط برای افتادن موقت به fetch |

> اگر فعلاً روتر نداری و می‌خواهی مستقیم به Render وصل شوی،
> UPSTREAM_FORWARDER_URL را روی https://<service>.onrender.com/fwd بگذار
> (یا ریشه؛ forwarder پایتونی هر دو را قبول می‌کند).

---

## ۶) فاز ۳ — Render Forwarder (خروجی)

### ۳.۰) GitHub و Render از صفر (قبل از هر چیز)

این معماری برای «IP پایدار + اثر انگشت Chrome» به یک سرویس عمومی HTTPS نیاز
دارد که forwarder روی آن اجرا شود. در این راهنما Render انتخاب شده چون رایگان
است و مستقیم از GitHub دیپلوی می‌شود. اگر Render نداشته باشی، زنجیره باز هم کار
می‌کند ولی بدون IP پایدار و بدون اثر انگشت Chrome (پایین‌تر توضیح داده شده).

#### الف) ساخت ریپوی GitHub

1. به github.com برو → New repository.
2. نام: FWD-app (یا هر نامی). Private امن‌تر است؛ Public هم کار می‌کند.
3. Create repository (بدون README و .gitignore، تا خالی باشد).
4. این فایل‌ها را از پوشه‌ی deploy/upstream_forwarder به **ریشه‌ی** ریپو اضافه کن:
   - forwarder.py
   - requirements.txt
   - render.yaml
   - اگر نسخه‌ی Node را هم می‌خواهی: upstream_forwarder.js و package.json
5. دو روش اضافه‌کردن:
   - وب: Add file → Upload files → فایل‌ها را بکش و رها کن → Commit to main.
   - گیت: git clone، فایل‌ها را کپی کن، git add/commit/push.
6. مطمئن شو شاخه‌ی اصلی main است و فایل‌ها در ریشه‌اند (نه در زیرپوشه). اگر در
   زیرپوشه‌اند، در Render مقدار Root Directory را همان زیرپوشه بگذار.

> اگر ریپوی ENMGhobadi/FWD-app را از قبل داری، همین فایل‌ها در ریشه‌اش هستند؛
> لازم نیست ریپوی جدید بسازی — همان را به Render بده.

> بدون این ریپو، Render چیزی برای ساختن ندارد. Render می‌تواند از Docker image
> هم دیپلوی کند، ولی ساده‌ترین و تست‌شده‌ترین راه همین GitHub است.

#### ب) ساخت اکانت Render و اتصال GitHub

1. render.com → Sign up (با GitHub).
2. به Render اجازه بده ریپوهایت را ببیند؛ اگر Private است، دسترسی همان ریپو را بده.
3. Dashboard → New.

#### ج) ساخت سرویس با Blueprint (ساده‌ترین)

1. New → Blueprint.
2. ریپوی FWD-app را انتخاب کن.
3. Render فایل render.yaml را می‌خواند و سرویس mhr-forwarder-py را می‌سازد:
   - Runtime: Python
   - Plan: Free
   - Region: Frankfurt
   - Build: pip install -r requirements.txt
   - Start: python forwarder.py
   - Health Check Path: /
4. فقط AUTH_KEY را می‌پرسد (چون sync:false است). همان کلید ≥ ۳۲ کاراکتری را وارد کن.
5. Apply / Create.
6. صبر کن تا Live شود. آدرس چیزی مثل https://mhr-forwarder-py.onrender.com است
   (اگر نام تکراری باشد، پسوند می‌گیرد).

#### د) ساخت سرویس به‌صورت دستی (اگر Blueprint را نمی‌خواهی)

New → Web Service → ریپو را انتخاب کن و این مقادیر را بگذار:

| فیلد | مقدار |
|---|---|
| Language | Python |
| Root Directory | خالی (یا مسیر فایل‌ها) |
| Build Command | pip install -r requirements.txt |
| Start Command | python forwarder.py |
| Health Check Path | / |
| Instance Type | Free |
| Region | Frankfurt |

Environment:

| نام | مقدار |
|---|---|
| AUTH_KEY | کلید تصادفی ≥ ۳۲ کاراکتر |
| HOST | 0.0.0.0 |
| IMPERSONATE | chrome |

→ Create Web Service.

#### ه) بعد از Deploy

- Logs را ببین: باید چیزی مثل
  listening on 0.0.0.0:<port> (profile=chrome, timeout=...) بیاید.
- GET / باید Forwarder Active + profile: chrome بدهد. از ایران خود
  onrender.com باز نمی‌شود؛ مهم نیست. با tools/check_exit.py یا یک fetcher
  بیرونی چک کن.
- آدرسی که در FORWARD_URLS می‌گذاری، همان https://<service>.onrender.com/fwd است.
- Render به‌طور پیش‌فرض با هر push به main خودش redeploy می‌کند (Auto-Deploy).
  اگر نمی‌خواهی، در Settings خاموشش کن.

#### و) اگر Render نمی‌خواهی

| گزینه | نتیجه |
|---|---|
| هیچ خروجی اضافه (MODE=fetch) | زنجیره کار می‌کند ولی IP کلادفلر (متغیر/مشترک) و اثر انگشت Node؛ برای کپچا مناسب نیست |
| VM با IP رزروشده (Oracle Always Free / GCP e2-micro) + همان forwarder.py پشت Caddy | تنها راه IP واقعاً ثابت — [راهنمای VM](../deploy/upstream_forwarder/README.md) |
| هر PaaS دیگری با Python/Node و HTTPS عمومی (Koyeb، Fly، Railway…) | همان فایل‌ها، همان قرارداد |
| Node forwarder روی Render | فقط IP پایدار، بدون Chrome |

> بدون یک سرویس عمومی HTTPS (Render/VM/…)، خروجی پایدار و Chrome نداری؛ خود
> mhr به‌تنهایی فقط رله‌ی Cloudflare است.

### گزینه A — Python + curl_cffi (توصیه‌شده برای کپچا)

فایل‌ها:

| فایل | کار |
|---|---|
| forwarder.py | سرور HTTP با همان قرارداد POST → {s,h,b} |
| requirements.txt | curl_cffi==0.16.3 |
| render.yaml | Blueprint برای ساخت سرویس Python |

روی Render:

1. New → Web Service (یا New → Blueprint).
2. ریپو را وصل کن (همان ریپویی که این سه فایل در ریشه‌اش هستند).
3. Language: Python (اگر package.json هم هست، دستی Python را انتخاب کن).
4. Root Directory: خالی (اگر فایل‌ها در ریشه‌اند).
5. Build Command: pip install -r requirements.txt
6. Start Command: python forwarder.py
7. Health Check Path: /
8. Instance: Free · Region: Frankfurt (یا نزدیک‌ترین)
9. Environment:

| نام | مقدار |
|---|---|
| AUTH_KEY | یک کلید تصادفی ≥ ۳۲ کاراکتر (همان برای همه‌ی forwarderها) |
| HOST | 0.0.0.0 |
| IMPERSONATE | chrome |

10. Deploy. بعد از Live شدن، GET / باید بدهد:
    Forwarder Active + profile: chrome
    (از ایران خود onrender باز نمی‌شود؛ مهم نیست. ورکر به آن وصل می‌شود.)

> نسخه‌ی پایتون: هر ۳.۱۰+ کار می‌کند؛ curl_cffi چرخ abi3 دارد و کامپایل
> لازم نیست. در این پروژه با ۳.۱۲ و curl_cffi 0.16.3 تست شد.

### گزینه B — Node (فقط IP پایدار، بدون اثر انگشت Chrome)

فایل‌ها: upstream_forwarder.js + package.json

- Build: npm install
- Start: node upstream_forwarder.js
- Env: AUTH_KEY، HOST=0.0.0.0

این نسخه فقط POST /fwd را قبول می‌کند (برخلاف نسخه‌ی پایتونی که / و /fwd/ را هم
می‌پذیرد). اثر انگشتش Node/OpenSSL + HTTP/1.1 است؛ برای سایت‌های سختگیر
کپچا مناسب نیست.

### نکته‌ی مهم: IP پایدار، نه IP ابدی

Render رنج‌های خروجی را بین سرویس‌های هر ریجن مشترک می‌دهد و IP اختصاصی پلن
پولی است. IP در حد یک نشست پایدار است و با ری‌استارت/ری‌دیپلوی عوض می‌شود.
برای IP واقعاً ثابت، VM با IP رزروشده (Oracle Always Free یا GCP e2-micro)
و همان forwarder را استفاده کن.

---

## ۷) فاز ۴ — چند اکانت Render

- برای هر اکانت/workspace یک سرویس Python بساز (نه چند سرویس در یک اکانت؛
  ۵ گیگ و ۷۵۰ ساعت بین سرویس‌های یک اکانت مشترک است).
- همه‌ی اکانت‌های Render می‌توانند به **همان ریپوی GitHub** وصل شوند (هر اکانت
  دسترسی ریپو را می‌دهد) یا از فورک استفاده کنند؛ لازم نیست کد را تکرار کنی.
- کلید AUTH_KEY را برای همه یکسان بگذار تا فقط URL عوض شود.
- هر اکانت یک ورودی در FORWARD_URLS می‌شود:

~~~
https://fwd-a.onrender.com/fwd,https://fwd-b.onrender.com/fwd,https://fwd-c.onrender.com/fwd
~~~

- برای هر سرویس یک KEEPALIVE_URLS بگذار:

~~~
https://fwd-a.onrender.com/,https://fwd-b.onrender.com/,https://fwd-c.onrender.com/
~~~

- ۲۴/۷ برای هر سرویس حدود ۷۴۴ ساعت در ماه است (داخل ۷۵۰). اگر اکانت دیگری هم
  روی همان workspace داری، سقف را رد می‌کنی و Render همه را suspend می‌کند.
- وقتی ۵ گیگ یک اکانت تمام شود، Render 502/503 می‌دهد؛ روتر آن را ناموفق
  علامت می‌زند و به اکانت بعدی می‌رود. اگر سرویس suspend شود، تا اول ماه
  برنمی‌گردد؛ آن URL را از FORWARD_URLS بردار.

> Render خودش failover بین اکانت‌ها ندارد. این کار را ورکر روتر انجام می‌دهد.

---

## ۸) فاز ۵ — Exit / Router Worker

فایل: deploy/exit-worker/worker.js

این ورکر هم hop دوم است و هم روتر استخر forwarderها:

- با MODE=forward، درخواست را به یکی از FORWARD_URLS می‌فرستد.
- ROUTER_MODE=sticky (پیش‌فرض): تا وقتی سرویس اول سالم است همان را استفاده
  می‌کند تا IP نشست عوض نشود؛ فقط هنگام خطا به بعدی می‌رود.
- هر خطای 5xx/شبکه/timeout/پاسخ نامعتبر، آن مقصد را برای
  FORWARD_COOLDOWN_MS (با ضریب خطاهای پشت‌سرهم، سقف ۱۰ دقیقه) کنار می‌گذارد.
- FORWARD_ATTEMPTS سقف تعداد تلاش در یک درخواست است (پیش‌فرض ۳).
- GET /status با هدر x-upstream-auth وضعیت استخر را نشان می‌دهد.
- Cron Trigger همه‌ی KEEPALIVE_URLS را پینگ می‌کند.

### ساخت

1. Cloudflare → Workers & Pages → Create → Hello World → نام mhr-exit.
2. کل worker.js را جای‌گذاری کن.
3. Deploy.
4. Settings → Variables and Secrets:

| متغیر | مقدار |
|---|---|
| RELAY_KEY | کلید ≥ ۳۲ کاراکتر (همان UPSTREAM_AUTH_KEY ورکر اصلی) |
| MODE | forward |
| FORWARD_URLS | لیست URLهای /fwd همه‌ی اکانت‌ها |
| FORWARD_KEY | همان AUTH_KEY سرویس‌های Render |
| ROUTER_MODE | sticky |
| FORWARD_ATTEMPTS | 3 |
| FORWARD_TIMEOUT_MS | 45000 |
| FORWARD_COOLDOWN_MS | 120000 |
| KEEPALIVE_URLS | لیست ریشه‌ی همه‌ی سرویس‌ها |

5. Deploy.
6. Settings → Triggers → Cron Triggers → */10 * * * *

### اتصال

- ورکر اصلی: UPSTREAM_FORWARDER_URL = آدرس همین روتر
  (https://mhr-exit.<account>.workers.dev) و UPSTREAM_AUTH_KEY = RELAY_KEY.
- دیگر لازم نیست برای هر اکانت جدید، ورکر اصلی را دست بزنی؛ فقط
  FORWARD_URLS و KEEPALIVE_URLS روتر را به‌روز کن و Deploy بزن.

### انتخاب حالت روتر

| ROUTER_MODE | رفتار | مناسب |
|---|---|---|
| sticky | یک خروجی تا زمان خطا | کپچا/نشست/IP ثابت (توصیه) |
| hash | بر اساس هاست مقصد | چند کاربر/چند سایت با توزیع |
| round-robin | چرخشی هر درخواست | فقط تست؛ برای کپچا بد است |

> وضعیت روتر داخل isolate ورکر است و Cloudflare ممکن است چند isolate داشته
> باشد؛ پس cooldownها best-effort هستند. انتخاب sticky قطعی است (ترتیب
> FORWARD_URLS) و همین رفتار قابل پیش‌بینی می‌دهد.

### تست

~~~bash
curl -s https://mhr-exit.<account>.workers.dev
# {"ok":true,...,"mode":"forward","routerMode":"sticky","pool":2,"keepalive":true}

curl -s https://mhr-exit.<account>.workers.dev/status \
  -H "x-upstream-auth: <RELAY_KEY>"
~~~

---

## ۹) فاز ۶ — پروکسی محلی

در پوشه‌ی mhr-cfw-2.0.2:

1. محیط مجازی:

~~~powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
~~~

اگر PyPI مشکل داشت، از میرور استفاده کن (در README_FA آمده است).

2. config.json را از config.example.json بساز و پر کن:

| کلید | مقدار |
|---|---|
| mode | apps_script |
| google_ip | 216.239.38.120 (یا خروجی python main.py --scan) |
| front_domain | www.google.com |
| script_id | Deployment ID گوگل |
| auth_key | همان AUTH_KEY داخل Code.gs |
| listen_port | 8085 |
| socks5_port | 1080 |
| lan_sharing | true اگر گوشی هم می‌خواهی |
| relay_timeout | 90 یا بیشتر (برای cold start) |
| forwarder_hosts | فعلاً [] (همه از زنجیره) یا فقط دامنه‌های حساس |

3. نصب CA (یک‌بار، با Administrator):

~~~powershell
python main.py --install-cert
~~~

4. اجرا:

~~~powershell
python main.py
~~~

باید ببینی:
- HTTP proxy listening on 0.0.0.0:8085
- SOCKS5 proxy listening on 0.0.0.0:1080
- MITM CA is already trusted

> اگر روی ویندوز چند گواهی هم‌نام mhr-cfw در Trust Store باشد، OpenSSL ممکن
> است نسخه‌ی قدیمی بدون SKI را انتخاب کند و خطای Missing Subject Key Identifier
> بدهد. ابزارهای این پروژه فقط ca/ca.crt فعلی را trust می‌کنند؛ برای کلاینت‌های
> دیگر (مثل curl ویندوز) در certmgr.msc فقط گواهی فعلی را نگه دار
> (Thumbprint: 4BA0F7F9A67BC5953C57DD795CB6EC7434B25D7E در این پروژه).

---

## ۱۰) فاز ۷ — مرورگر و گوشی

مرورگر (کروم/اج):

- FoxyProxy یا SwitchyOmega → HTTP → 127.0.0.1:8085.
- یا Proxy سیستم ویندوز → 127.0.0.1:8085.
- تست: https://ipv4.icanhazip.com باید IP Render را بدهد (نه IP واقعی).

فایرفاکس مخزن گواهی جدا دارد؛ اگر خطای گواهی دیدی، ca/ca.crt را در
Settings → Privacy → Certificates → Authorities وارد کن.

گوشی (شبکه‌ی محلی):

- IP لپ‌تاپ را پیدا کن (ipconfig). اگر هات‌اسپات لپ‌تاپ است معمولاً
  192.168.137.1؛ اگر وای‌فای مشترک است، IP وای‌فای.
- Proxy گوشی: Manual → host همان IP → port 8085.
- ca/ca.crt را روی گوشی نصب کن (Android: Security → Install certificate →
  CA certificate).
- اگر وصل نشد، Windows Firewall یک Inbound Rule برای TCP 8085 اضافه کن.

> v2ray لازم نیست. mhr پروکسی HTTP/SOCKS5 است، نه سرور VLESS. برای
> TUN/کل ترافیک سیستمی و UDP، این معماری پوشش نمی‌دهد.

---

## ۱۱) فاز ۸ — تأیید

### ابزار ۱: چه چیزی مقصد می‌بیند؟

~~~powershell
python tools/check_exit.py
~~~

انتظار (وقتی forwarder پایتونی در مسیر است):

~~~
exit IP  : <ip>
JA4      : t13d1516h2_...  یا  t13d1517h2_...
HTTP     : h2
verdict  : Chrome-like TLS + HTTP/2
~~~

اگر JA4 برابر t13d5212h1 و HTTP برابر h1 بود، هنوز Node/fetch در مسیر است.

### ابزار ۲: پایداری IP

~~~powershell
python tools/ip_probe.py --count 20 --expect-single
python tools/ip_probe.py --url https://ipv4.icanhazip.com --count 5 --rounds 4 --round-interval 300
~~~

- STABLE: یک IP برای همه.
- SESSION-STABLE: هر مرحله یک IP، بین مرحله‌ها عوض شده (برای نشست معمولاً OK).
- MOSTLY-STABLE / ROTATING: استخر بزرگ؛ برای کپچا مناسب نیست.

### تست واقعی کپچا

با Chrome از طریق پروکسی، یک سایت Cloudflare-challenge (مثل nowsecure.nl) را
باز کن. اگر صفحه‌ی واقعی آمد (نه Just a moment)، یعنی اثر انگشت و هدرها
درست است. در این پروژه با Chrome headless از داخل زنجیره تست شد و صفحه‌ی
واقعی nowsecure.nl برگشت.

---

## ۱۲) بهره‌برداری روزانه

- پنجره‌ی python main.py باید باز بماند.
- Cron روتر را خاموش نکن؛ وگرنه Render می‌خوابد و اولین درخواست 502 می‌شود.
- ۵ گیگ هر اکانت را بپا: با همه‌چیز از Render زود تمام می‌شود. با
  forwarder_hosts فقط دامنه‌های حساس را از زنجیره بفرست.
- برای اضافه‌کردن اکانت: سرویس Python جدید بساز، URL را به FORWARD_URLS و
  ریشه را به KEEPALIVE_URLS اضافه کن، Deploy.
- برای حذف اکانت: همان دو لیست را به‌روز کن.
- هر بار کد ورکرها/forwarder را عوض کردی: Deploy فراموش نشود.
- Render را بی‌دلیل ری‌دیپلوی نکن؛ ممکن است IP عوض شود.

---

## ۱۳) عیب‌یابی

| نشانه | علت | راه‌حل |
|---|---|---|
| 404 از forwarder | URL بدون /fwd (نسخه Node) یا مسیر اشتباه | /fwd را اضافه کن؛ نسخه Python / و /fwd/ را هم قبول می‌کند |
| 501 | متد پشتیبانی‌نشده (مثلاً HEAD روی نسخه قدیمی) | کد جدید do_HEAD دارد؛ Deploy کن |
| 502 اول هر نشست | Render خواب بوده | Cron */10؛ اولین درخواست را تکرار کن |
| 502/503 بعد از مدتی | ۵ گیگ تمام شده یا سرویس suspend | اکانت/URL بعدی؛ روتر خودش failover می‌کند |
| 403/1020 از سایت | IP مشترک Render بلاک شده | ریجن/اکانت دیگر یا IP رزیدنشی |
| Missing Subject Key Identifier | چند گواهی هم‌نام در Trust Store | فقط CA فعلی را نگه دار؛ ابزارها CA-only هستند |
| upstream HTTP 404 from script | GAS Deployment/سهمیه | Deployment جدید بساز و script_id را عوض کن |
| WebSocket errors | رله HTTP است، WS پشتیبانی نمی‌شود | طبیعی؛ صفحه کار می‌کند |
| google.com مستقیم می‌رود | direct_google_exclude/youtube_via_relay | by design؛ اگر لازم شد youtube_via_relay=true |
| 401 | کلیدها یکی نیستند | RELAY_KEY/UPSTREAM_AUTH_KEY/FORWARD_KEY/AUTH_KEY را هم‌سان کن |
| relay error: fetch failed | مقصد/پروتکل مشکل دارد | با curl مستقیم تست کن |
| HTML به‌جای JSON | آدرس اشتباه (پنل/سرویس دیگر) | آدرس /fwd یا ریشه‌ی forwarder را چک کن |

---

## ۱۴) چیزهایی که جواب نداد (تا دوباره امتحان نکنی)

1. وصل‌کردن ورکر اصلی به BPB به‌عنوان upstream:
   BPB فقط VLESS/Trojan over WebSocket و مسیرهای پنل را می‌فهمد؛ POST JSON
   به آن 404 می‌دهد. حتی با پچ، خروجی‌اش Cloudflare است و IP تمیز نمی‌دهد.
2. فرستادن IP رندربه BPB (Proxy IP / Chain Proxy / cleanIP):
   پروتکل‌ها نمی‌خوانند؛ cleanIP آدرس ورودی است، نه خروجی.
3. انتظار IP ابدی از Render:
   رنج‌ها مشترک‌اند؛ IP در حد نشست پایدار است.
4. round-robin برای کپچا:
   هر درخواست IP عوض می‌شود و نشست می‌شکند. sticky استفاده کن.
5. MODE=socket به‌عنوان جایگزین:
   egress سوکت کلادفلر هم بومی/مشترک است و JA4 کرومی ندارد.
6. اتکا به httpbin تنها:
   httpbin دو-پروتکلی است و ممکن است IPv6 نشان دهد؛ برای سنجش IPv4 از
   ipv4.icanhazip.com استفاده کن.

---

## ۱۵) امنیت

- AUTH_KEY/RELAY_KEY را ≥ ۳۲ کاراکتر و تصادفی بگذار (مثلاً openssl rand -hex 32).
- کلیدها را در گیت نگذار؛ فقط در Environment Render/Cloudflare.
- ca/ca.key را هرگز به کسی نده.
- forwarder یک رله‌ی authenticated است؛ اگر کلید لو برود، می‌توانند از
  پهنای‌باند تو استفاده کنند. کلید لو‌رفته را عوض کن.
- سرویس‌های Render را روی 0.0.0.0 بگذار (Render نیاز دارد)، ولی روی VPS
  شخصی پشت فایروال/Caddy نگه دار.
- forwarder پایتونی SSRF دارد (private/loopback/metadata را رد می‌کند) و
  ریدایرکت‌ها را دوباره اعتبارسنجی می‌کند؛ ALLOW_PRIVATE را فقط برای تست
  محلی روشن کن.

---

## ۱۶) پیوست: مرجع متغیرها

### ورکر اصلی (mhr)

| متغیر | توضیح |
|---|---|
| WORKER_URL (ثابت در کد) | دامنه‌ی خود ورکر (ضد self-fetch) |
| UPSTREAM_FORWARDER_URL | آدرس روتر یا forwarder |
| UPSTREAM_AUTH_KEY | کلید روتر (RELAY_KEY) یا forwarder (AUTH_KEY) |
| UPSTREAM_TIMEOUT_MS | باید از کل زمان تلاش‌ها بیشتر باشد (مثلاً 150000) |
| UPSTREAM_FAIL_MODE | closed یا open |

### روتر (exit-worker)

| متغیر | توضیح |
|---|---|
| RELAY_KEY | کلید ورودی از ورکر اصلی |
| MODE | forward |
| FORWARD_URLS | استخر URLهای /fwd |
| FORWARD_KEY | کلید forwarderها |
| ROUTER_MODE | sticky / hash / round-robin |
| FORWARD_ATTEMPTS | سقف تلاش |
| FORWARD_TIMEOUT_MS | تایم‌اوت هر تلاش |
| FORWARD_COOLDOWN_MS | cooldown پس از خطا |
| KEEPALIVE_URLS | لیست ریشه‌ی سرویس‌ها برای cron |

### Render (Python)

| متغیر | توضیح |
|---|---|
| AUTH_KEY | همان FORWARD_KEY |
| HOST | 0.0.0.0 |
| IMPERSONATE | chrome |
| TIMEOUT_MS | اختیاری؛ پیش‌فرض 25000 |
| MAX_BODY_BYTES | اختیاری؛ پیش‌فرض 50MB |

### پروکسی محلی (config.json)

| کلید | توضیح |
|---|---|
| mode | apps_script |
| google_ip / front_domain | مسیر ورودی گوگل |
| script_id / auth_key | GAS |
| listen_port / socks5_port | 8085 / 1080 |
| relay_timeout | 90+ |
| forwarder_hosts | دامنه‌هایی که باید از زنجیره بروند |

---

## ۱۷) پیوست: ساختار فایل‌ها

~~~
mhr-cfw-2.0.2/
├── deploy/
│   ├── gas/Code.gs
│   ├── cloudflare-worker/worker.js
│   ├── exit-worker/worker.js          ← روتر/هوپ دوم
│   └── upstream_forwarder/
│       ├── forwarder.py               ← Python + curl_cffi (Chrome)
│       ├── requirements.txt
│       ├── render.yaml
│       ├── upstream_forwarder.js      ← Node (fallback)
│       └── package.json
├── src/                               ← پروکسی محلی
├── tools/
│   ├── check_exit.py                  ← IP + JA4
│   └── ip_probe.py                    ← پایداری IP
├── config.json
└── docs/REBUILD_FA.md                 ← همین سند
~~~

ریپوی FWD-app (برای Render) باید داشته باشد:

~~~
forwarder.py
requirements.txt
render.yaml
upstream_forwarder.js
package.json
~~~

---

## ۱۸) چک‌لیست نهایی از صفر

- [ ] GAS ساخته و Deploy شد؛ AUTH_KEY و WORKER_URL درست.
- [ ] ورکر اصلی Deploy شد؛ WORKER_URL داخل کد عوض شد.
- [ ] سرویس Python روی Render ساخته شد؛ AUTH_KEY/HOST/IMPERSONATE درست.
- [ ] GET / سرویس، Forwarder Active + profile: chrome می‌دهد.
- [ ] روتر Deploy شد؛ FORWARD_URLS، FORWARD_KEY، KEEPALIVE_URLS درست.
- [ ] Cron Trigger روتر روی */10 * * * * است.
- [ ] ورکر اصلی به روتر وصل است؛ UPSTREAM_TIMEOUT_MS کافی.
- [ ] config.json ساخته و script_id/auth_key درست.
- [ ] CA نصب شده؛ python main.py بالا است.
- [ ] مرورگر روی 127.0.0.1:8085.
- [ ] check_exit: JA4 کرومی + h2.
- [ ] ip_probe: STABLE.
- [ ] تست کپچا در Chrome.
- [ ] یک سرویس به ازای هر اکانت Render؛ سقف ۵ گیگ/۷۵۰ ساعت در ذهن.

---

## ۱۹) وضعیت نسخه‌های تست‌شده در این پروژه

| مورد | نسخه/مقدار |
|---|---|
| curl_cffi | 0.16.3 |
| Python forwarder | 3.10+ (تست با 3.12) |
| Render | Free، Frankfurt |
| Cloudflare Workers | Free |
| Google Apps Script | Free |
| Chrome | 156 (تست) |
| JA4 مطلوب | t13d1516h2 / t13d1517h2 |
| JA4 نامطلوب | t13d5212h1 (Node) |

---

## ۲۰) جمع‌بندی

- ورودی از Google است چون فقط آن از ایران باز است.
- خروجی از Render است چون IP پایدار در حد نشست می‌دهد.
- اثر انگشت با curl_cffi کرومی می‌شود چون کپچا TLS را می‌سنجد.
- روتر چند اکانت را با sticky + failover مدیریت می‌کند تا 502/503 و سقف
  ۵ گیگ باعث توقف کامل نشود.
- برای IP واقعاً ابدی، VM با IP رزروشده تنها راه مطمئن است.
