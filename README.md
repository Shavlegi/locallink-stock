# locallink-stock — მარაგის backend + ადმინ პანელი

მარაგის მართვის სისტემა locallink მაღაზიისთვის (https://locallink.store/).
მაღაზია სტატიკური საიტია და მარაგს თვითონ ვერ ინახავს, ამიტომ მარაგი
ცხოვრობს აქ: პატარა Cloudflare Worker + D1 ბაზა — იგივე დამტკიცებული
მოდელი, რაც Mini Link-ს აქვს.

## როგორ მუშაობს

- **მაღაზია** ჩატვირთვისას ერთხელ ითხოვს `GET /api/stock`-ს და აჩვენებს
  თითოეული პროდუქტის ქვემოთ: `მარაგშია: X ცალი` და/ან
  `მალე დაემატება: Y ცალი`. API რომ მიუწვდომელია, ხაზები უბრალოდ არ
  ჩანს — მაღაზია ჩვეულად მუშაობს.
- **ადმინ პანელი** (`/admin`) — შესვლა პაროლით; 5 პროდუქტის მწკრივი,
  თითოეულში მარაგის რაოდენობა (+/− ღილაკებით), მოსალოდნელი დამატება
  და შენახვის ღილაკი. ცარიელი ველი = რაოდენობა არ ჩანს მაღაზიაში.
- **მნიშვნელობა:** ჩანაწერის არარსებობა ან `NULL` = დაყენებული არ არის
  (ხაზი არ ჩანს); `stock = 0` = „მარაგი ამოწურულია".

## დაყენება (Cloudflare dashboard, ტერმინალი არ სჭირდება)

1. **D1 ბაზა:** Cloudflare dashboard → Workers & Pages → D1 (Storage) →
   Create database, სახელი `locallink-stock-db`. დააკოპირე მისი
   `database_id` და ჩასვი `wrangler.toml`-ში
   `REPLACE_WITH_YOUR_D1_DATABASE_ID`-ის ადგილას.
2. **Worker:** Workers & Pages → Create → Connect to Git → ეს რეპო.
   Worker-ის სახელი `locallink-stock` — მისამართი იქნება
   `https://locallink-stock.<ანგარიში>.workers.dev`.
3. **საიდუმლოებები** (Worker → Settings → Variables and Secrets):
   - `ADMIN_PASSWORD_HASH` — დაგენერირდება ხელსაწყოთი
     `~/workspace/url-shortener/scripts/make-hash.html` (ბრაუზერში იშლება;
     პაროლს იქ წერ, hash-ს გაძლევს). მნიშვნელობა არასდროს ჩაწერო ჩატში
     ან რეპოში.
   - `SESSION_SECRET` — გრძელი შემთხვევითი სტრიქონი.
4. **Deploy.** Worker-ი პირველივე მოთხოვნაზე თვითონ ქმნის D1 ცხრილებს
   (lazy idempotent სქემა) — მიგრაციების გაშვება არ სჭირდება.
5. **შემოწმება:** გახსენი `https://locallink-stock.<ანგარიში>.workers.dev/admin`,
   შედი პაროლით, შეავსე ერთი პროდუქტის მარაგი, შეინახე და ნახე, რომ
   მაღაზიაში ხაზი გაჩნდა.

## API

| მეთოდი | გზა | აღწერა |
|---|---|---|
| `GET` | `/` | სტატუსი: `{ok, service}` |
| `GET` | `/admin` | ადმინ პანელის გვერდი (ერთი თვითკმარი HTML) |
| `GET` | `/api/stock` | საჯარო: `{slug: {stock, incoming}}` ყველა 5 პროდუქტზე; CORS მხოლოდ locallink.store / shavlegi.github.io-დან; ლიმიტი 120/წთ ერთ IP-ზე |
| `POST` | `/api/admin/login` | `{password}` → session cookie (7 დღე); ლიმიტი 5 მცდელობა/წთ ერთ IP-ზე |
| `POST` | `/api/admin/logout` | სესიის წაშლა |
| `GET` | `/api/admin/session` | `{ok:true}` თუ შესულია |
| `GET` | `/api/admin/stock` | ყველა მწკრივი (auth საჭიროა) |
| `POST` | `/api/admin/stock` | `{slug, stock, incoming}` upsert (auth საჭიროა); რაოდენობა: მთელი რიცხვი 0–99999 ან `null` |

## უსაფრთხოება

- პაროლი: PBKDF2-SHA256, 100 000 იტერაცია, constant-time შედარება.
- სესია: შემთხვევითი ტოკენი, ბაზაში მხოლოდ SHA-256 hash ინახება
  (SESSION_SECRET-ით); cookie არის HttpOnly + Secure + SameSite=Lax.
- Rate limiting IP-hash-ით (დღიური მარილით) — ნედლი IP არსად ინახება.
- მუტაციური API-ები ამოწმებენ `Origin`-ს (მხოლოდ იმავე ჰოსტი).
- საიდუმლოებები მხოლოდ env ცვლადებში — კოდში და რეპოში არაფერია.

## ტესტები

```sh
node test/stock-harness.mjs
```

44 შემოწმება plain node-ით (D1 mock `node:sqlite`-ზე): საჯარო API-ს
ფორმა + CORS, ლოგინის უარყოფა, არაავტორიზებულის უარყოფა, upsert-ის
ვალიდაცია, rate limit-ები, logout. ტესტის პაროლი/საიდუმლო მხოლოდ
ტესტისთვისაა და არ გამოიყენება production-ში.

## სტატუსი

- 2026-11-15: Worker გაშვებულია (`locallink-stock.shao42ia.workers.dev`),
  D1 `locallink-stock-db` დაკავშირებულია, secrets დაყენებულია.
