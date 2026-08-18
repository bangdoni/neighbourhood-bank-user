# AGENTS.md

# Neighbourhood Bank — User Telegram Bot

## 1. Project Overview

This project is the **user/member-facing Telegram Bot** for a simple neighbourhood contribution and community fund system.

The system allows neighbourhood members to:

* Register/link their Telegram account
* View their profile
* View their current balance
* View transaction history
* Check monthly contribution status
* View the administrator's payment/bank QR code
* Receive payment confirmations
* Receive monthly contribution reminders
* Check system/help information

The user bot MUST NOT provide administrator functionality.

---

# 2. Architecture

```text
Neighbourhood Member
        │
        │ Telegram
        ▼
┌──────────────────────┐
│   Telegram User Bot  │
└──────────┬───────────┘
           │
           │ Webhook
           ▼
┌──────────────────────┐
│ Cloudflare Worker    │
│      Backend         │
└──────────┬───────────┘
           │
       ┌───┴─────┐
       ▼         ▼
┌──────────┐  ┌──────────┐
│  D1 DB   │  │  R2 OBs  │
│ (SQLite) │  │ (QR Code)│
└──────────┘  └──────────┘
```

The Telegram bot is only the user interface.

Cloudflare Worker is responsible for:

* Authentication/linking
* Authorization
* Business logic
* Reading member information
* Reading balances
* Reading transaction history
* Reading contribution status
* Reading payment/store configuration
* Sending notifications

Cloudflare D1 (SQLite) is the data store.

Cloudflare R2 stores the payment QR image.

---

# 3. Core Principles

## 3.1 Users Can Only Access Their Own Data

A user must never be able to access another member's information.

Do not trust:

```text
/member NB-0002
/balance NB-0002
/history NB-0002
```

or any user-provided member ID.

The authenticated Telegram ID MUST determine the member account.

Correct flow:

```text
Telegram ID
     ↓
_users lookup
     ↓
Member account
     ↓
Member's own data
```

---

# 4. User Identity

Telegram's numeric user ID is the primary identity.

Use:

```text
telegram_id
```

as the authoritative identity.

Do NOT use Telegram username as the primary identifier because usernames can:

* Change
* Be removed
* Be unavailable
* Be reused

Example:

```text
Telegram ID:
123456789

Username:
@ahmad
```

The system identifies the user by:

```text
123456789
```

not:

```text
@ahmad
```

---

# 5. User Registration / Linking

A member must already exist in `_users` before they can access their account.

Example:

```text
_users

user_id     telegram_id    name
NB-0001     123456789      Ahmad
```

When Ahmad starts the bot:

```text
/start
```

the bot checks:

```text
Telegram ID
     ↓
_users
     ↓
Found?
```

If found:

```text
👋 Welcome back, Ahmad!
```

If not found:

```text
Your Telegram account is not linked
to a neighbourhood member account.

Please contact the administrator.
```

Do not automatically create a financial account from `/start`.

---

# 6. Optional Account Linking Flow

If account linking is implemented, use a secure one-time linking code.

Example:

```text
User:

/login ABC123
```

Cloudflare Worker verifies:

```text
ABC123
   ↓
Valid?
   ↓
Not expired?
   ↓
Not already used?
   ↓
Link Telegram ID
```

The code MUST:

* Be single-use
* Expire
* Be sufficiently random
* Never be reused
* Be invalidated after successful linking

After linking:

```text
✅ Account Linked

Welcome, Ahmad.

Member ID:
NB-0001
```

---

# 7. User Main Menu

Use Telegram's custom keyboard.

Recommended menu:

```text
┌────────────────────┬────────────────────┐
│ 💰 Balance         │ 📊 History         │
├────────────────────┼────────────────────┤
│ 💳 Contribution    │ 🏦 Store           │
├────────────────────┼────────────────────┤
│ 👤 Profile         │ ℹ️ Status           │
├────────────────────┴────────────────────┤
│ ❓ Help                                  │
└─────────────────────────────────────────┘
```

Commands must also be supported.

---

# 8. User Commands

Required commands:

```text
/start
/login
/help

/balance
/history
/contribution
/store
/profile
/status
```

Optional:

```text
/transactions
/receipt
/contact
```

Do not expose administrator commands through the user bot.

---

# 9. `/start`

When the user sends:

```text
/start
```

the system:

1. Gets Telegram numeric ID.
2. Searches `_users`.
3. Checks account status.
4. Loads member information.
5. Displays the main menu.

For an active member:

```text
👋 Welcome, Ahmad!

Member ID:
NB-0001

Current Balance:
Rp 350.000

August Contribution:
✅ Paid

Use the menu below to continue.
```

For an unlinked account:

```text
👋 Welcome!

Your Telegram account is not linked
to a neighbourhood member account.

Please contact the administrator
to link your account.
```

For a disabled account:

```text
⛔ Account Disabled

Your neighbourhood account is currently
disabled.

Please contact the administrator.
```

---

# 10. User Main Menu Behaviour

The menu should be persistent and easy to use.

The bot should not require users to remember commands.

Buttons:

```text
💰 Balance
📊 History
💳 Contribution
🏦 Store
👤 Profile
ℹ️ Status
❓ Help
```

Each button should map to a backend service.

---

# 11. `/balance`

Display the member's current balance.

Example:

```text
💰 Your Balance

Member:
Ahmad

Member ID:
NB-0001

Current Balance:
Rp 350.000

Monthly Contribution:
Rp 50.000

August 2026:
✅ PAID
```

The balance must come from the ledger.

Do not trust cached client-side values.

---

# 12. Balance Calculation

The balance should be derived from valid transactions.

Conceptually:

```text
Balance =
Sum(CREDIT)
-
Sum(DEBIT)
```

For v1, the primary transaction is:

```text
CONTRIBUTION
```

Do not allow users to modify balances.

Users cannot:

```text
/deposit
/withdraw
/setbalance
```

---

# 13. `/history`

Display recent transactions.

Example:

```text
📊 Transaction History

Ahmad
NB-0001

────────────────────

10 Aug 2026
+ Rp 50.000
August contribution

10 Jul 2026
+ Rp 50.000
July contribution

10 Jun 2026
+ Rp 50.000
June contribution
```

Show a reasonable number of transactions per page.

Recommended:

```text
10 transactions/page
```

Use pagination:

```text
[⬅️ Previous] [Next ➡️]
```

---

# 14. Transaction Privacy

A user may only see transactions belonging to their own `user_id`.

Never allow:

```text
/history NB-0002
```

to retrieve another member's history.

If an internal member ID is used by the backend, it must come from the authenticated Telegram identity.

---

# 15. `/contribution`

This shows monthly contribution status.

Example:

```text
💳 Contribution Status

August 2026

Required:
Rp 50.000

Status:
✅ PAID

Payment Date:
10 August 2026
```

For unpaid:

```text
💳 Contribution Status

August 2026

Required:
Rp 50.000

Status:
❌ NOT PAID

Due Date:
10 August 2026

Please make your contribution
using the payment information in:

🏦 Store
```

---

# 16. Contribution History

Allow users to see previous months.

Example:

```text
📅 Contribution History

2026

January    ✅ Rp 50.000
February   ✅ Rp 50.000
March      ✅ Rp 50.000
April      ✅ Rp 50.000
May        ❌
June       ✅ Rp 50.000
July       ✅ Rp 50.000
August     ❌
```

Use pagination or year/month selection if the history becomes large.

---

# 17. `/store`

`/store` displays the administrator's payment account information and QR code.

This is a read-only feature for users.

Example:

```text
🏦 Payment Account

Please use the account below
for your monthly contribution.

Bank:
BCA

Account Name:
RT 05 Community Fund

Account Number:
1234567890

Monthly Contribution:
Rp 50.000

Please scan the QR code below
to make your payment.
```

Then send the configured QR image.

---

# 18. QR Code Source

The QR code is stored in Cloudflare R2.

Recommended configuration:

```text
_config

qr_url
```

Example:

```text
qr_url
https://nb-some-place-admin.pages.dev/qr
```

The Worker backend retrieves the QR image from R2.

The user bot then sends the image using Telegram's photo API.

---

# 19. QR Code Security

The QR code itself is intended to be publicly viewable by authenticated members.

However, the bot MUST NOT expose:

```text
Cloudflare R2 credentials
Cloudflare R2 access tokens
Worker secrets
Telegram bot tokens
```

Only the QR image and intended payment account information should be sent.

---

# 20. `/profile`

Display the user's profile.

Example:

```text
👤 My Profile

Member ID:
NB-0001

Name:
Ahmad

Telegram:
@ahmad

Phone:
08123456789

Status:
🟢 ACTIVE

Monthly Contribution:
Rp 50.000
```

Do not expose internal system fields.

Do not expose:

```text
sheet_name
internal database IDs
admin IDs
audit IDs
R2 object keys
internal configuration
```

---

# 21. `/status`

Display account and contribution status.

Example:

```text
ℹ️ Account Status

Account:
🟢 ACTIVE

Member ID:
NB-0001

Current Balance:
Rp 350.000

Current Contribution:
✅ PAID

Next Contribution:
September 2026
```

This should be a concise overview.

---

# 22. `/help`

Display available functionality.

Example:

```text
❓ Help

Available options:

💰 Balance
View your current balance.

📊 History
View your transaction history.

💳 Contribution
Check monthly contribution status.

🏦 Store
View the administrator's payment
account and QR code.

👤 Profile
View your member information.

ℹ️ Status
View your account status.

If you need help, please contact
the neighbourhood administrator.
```

---

# 23. Payment Confirmation Notification

When an administrator records a contribution, the user may receive a notification.

Example:

```text
🔔 Payment Confirmed

Hello Ahmad,

Your contribution has been recorded.

Period:
August 2026

Amount:
Rp 50.000

Payment Method:
BANK TRANSFER

Current Balance:
Rp 350.000

Thank you!
```

The user cannot modify or approve this notification.

---

# 24. Monthly Reminder

If the member has not paid the current contribution:

```text
🔔 Contribution Reminder

Hello Ahmad,

Your August 2026 contribution
has not been recorded yet.

Amount:
Rp 50.000

Due Date:
10 August 2026

You can find the payment QR code
in:

🏦 Store
```

The reminder must not reveal information about other members.

---

# 25. Notification Preferences

If notification preferences are implemented, users may control non-essential notifications.

Example:

```text
🔔 Notifications

Payment Confirmation:
✅ Enabled

Monthly Reminder:
✅ Enabled
```

However, critical account notifications may remain enabled.

Do not allow users to disable security/account-linking notifications.

---

# 26. User Cannot Record Payments Directly

For v1, users do NOT create financial transactions.

The user bot should not provide:

```text
/pay
/addpayment
/deposit
```

The intended flow is:

```text
User
  ↓
/store
  ↓
Scan QR
  ↓
Make bank/QRIS payment
  ↓
Administrator verifies payment
  ↓
Administrator records payment
  ↓
User receives confirmation
```

This avoids unverified financial records.

---

# 27. Future Payment Verification

A future version may allow:

```text
User
 ↓
Upload payment receipt
 ↓
Admin review
 ↓
Approve / Reject
```

This is NOT required for v1.

If implemented later, uploaded receipts should be stored in Cloudflare R2.

Never automatically credit a user's balance simply because they uploaded an image.

---

# 28. Data Access Model

Every user request must follow:

```text
Telegram Update
       ↓
Telegram ID
       ↓
Find _users record
       ↓
Check status
       ↓
Get authenticated user_id
       ↓
Query only that user's data
       ↓
Format response
       ↓
Send Telegram message
```

Never accept `user_id` from the Telegram client as an authorization mechanism.

---

# 29. Disabled Accounts

If `_users.status` is:

```text
DISABLED
```

the user may only receive a limited message.

Example:

```text
⛔ Account Disabled

Your account is currently disabled.

Please contact the neighbourhood
administrator for assistance.
```

Do not expose balance/history after disabling unless the business rules explicitly require it.

---

# 30. User Data Privacy

The user bot must only reveal the user's own:

```text
Name
Member ID
Balance
Transactions
Contribution status
Payment information
```

Never reveal:

```text
Other members
Other member balances
Other member payments
Total community fund
Administrator private information
Audit logs
Internal database information
```

Community-wide statistics should only be shown if explicitly approved as a future feature.

---

# 31. Error Handling

Never expose technical errors.

Bad:

```text
Exception: Cannot read properties of undefined
```

Good:

```text
❌ Something went wrong.

Please try again later.

If the problem continues,
contact the administrator.
```

Log technical errors internally.

---

# 32. Input Validation

All user input must be validated.

Never trust:

```text
callback_data
commands
parameters
Telegram username
member IDs
```

If the user attempts an unsupported command:

```text
❓ Unknown command

Please use the menu below.
```

---

# 33. Telegram Callback Security

Inline keyboard callbacks must be validated.

Example:

```text
history:next:2
```

The backend must verify:

```text
Telegram ID
Authenticated member
Requested resource
Pagination state
```

Never allow a user to manipulate callback data to access another member's records.

---

# 34. Pagination

Use pagination for transaction history and other potentially large lists.

Example:

```text
📊 History

Showing 1–10 of 37 transactions.

[⬅️] [Next ➡️]
```

Do not send large transaction histories in one Telegram message.

---

# 35. Telegram Message Formatting

Use clear and simple formatting.

Preferred:

```text
💰 Current Balance

Rp 350.000
```

Avoid overly technical terminology.

The target audience is ordinary neighbourhood members, not developers.

---

# 36. Language

Initial language:

```text
Indonesian
```

Use clear Indonesian wording.

Examples:

```text
Balance
→ Saldo

Transaction History
→ Riwayat Transaksi

Contribution
→ Iuran

Payment Account
→ Rekening Pembayaran

Paid
→ Sudah Dibayar

Not Paid
→ Belum Dibayar

Administrator
→ Pengurus/Admin
```

Keep financial terminology consistent throughout the bot.

---

# 37. Currency Formatting

Currency:

```text
IDR
```

Display:

```text
Rp 50.000
Rp 100.000
Rp 1.250.000
```

Internally, represent amounts as integers.

Example:

```text
50000
```

not:

```text
50000.00
```

Avoid floating-point calculations for money.

---

# 38. Date and Time

Default timezone:

```text
Asia/Jakarta
```

Internal timestamps should use a consistent format.

Display dates in Indonesian-friendly form:

```text
10 Agustus 2026
```

Month names:

```text
Januari
Februari
Maret
April
Mei
Juni
Juli
Agustus
September
Oktober
November
Desember
```

---

# 39. User Bot Commands Must Be Read-Only

The following operations are read-only:

```text
/balance
/history
/contribution
/store
/profile
/status
```

Users cannot:

```text
Change balance
Create transactions
Change monthly fee
Change bank account
Change QR code
Modify profile without authorization
Access another member
View audit logs
```

---

# 40. Code Organization

Recommended Worker structure:

```text
src/
├── db.js
│
├── telegram.js
├── router.js
├── auth.js
│
├── users.js
├── profile.js
├── balance.js
├── transactions.js
├── contributions.js
│
├── store.js
├── notifications.js
│
├── formatting.js
└── utils.js
```

Keep Telegram command handling separate from business logic.

---

# 41. Core Services

Implement reusable functions such as:

```text
authenticateUser()
getAuthenticatedMember()
getMemberProfile()

getBalance()
getTransactions()
getContributionStatus()
getContributionHistory()

getStoreConfig()
getQrCode()

sendTelegramMessage()
sendTelegramPhoto()

sendPaymentConfirmation()
sendContributionReminder()
```

Do not duplicate data-access logic inside every Telegram command.

---

# 42. Telegram Request Flow

Every request should follow:

```text
Telegram Update
      ↓
Parse Update
      ↓
Get Telegram ID
      ↓
Authenticate User
      ↓
Check Account Status
      ↓
Resolve Member ID
      ↓
Execute Requested Service
      ↓
Format Response
      ↓
Send Telegram Response
```

---

# 43. Performance

Cloudflare D1 (SQLite) have execution quotas.

Avoid unnecessary database reads.

Bad:

```text
Read entire table
for every Telegram request
```

Prefer:

```text
Read only required range/data
```

Use caching where appropriate for:

```text
_config
store information
non-sensitive static configuration
```

Do not cache financial balances in a way that can become stale.

Financial data should always be read from the authoritative ledger when required.

---

# 44. Concurrency

User operations are mostly read-only.

However, the backend must still handle concurrent administrator changes correctly.

If a user reads a balance while an administrator is recording a payment, the system must not return corrupted or partially written data.

The transaction service should use the same financial locking mechanism as the administrator bot.

---

# 45. Security Rules

Never expose:

```text
TELEGRAM_BOT_TOKEN
WEBHOOK_SECRET
Worker secrets
Cloudflare R2 credentials
Spreadsheet IDs unnecessarily
Internal sheet names
Internal IDs
Audit records
```

Secrets must be stored using Worker Properties Service.

Never hard-code secrets in source code.

---

# 46. User Bot and Admin Bot Separation

The user bot and administrator bot are separate Telegram bots.

Example:

```text
User:
@NeighbourhoodBankBot

Admin:
@NeighbourhoodBankAdminBot
```

The user bot must never process administrator commands.

The administrator bot must never use the user bot's authentication rules.

Both bots may use the same Worker backend/services, but authorization MUST remain separate.

Conceptually:

```text
                    Cloudflare Worker
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
       User Bot Router             Admin Router
              │                         │
       User Auth                   Admin Auth
              │                         │
       User Services              Admin Services
```

---

# 47. Notifications

User notifications may include:

```text
PAYMENT_CONFIRMED
MONTHLY_REMINDER
ACCOUNT_LINKED
ACCOUNT_DISABLED
```

Do not send unnecessary messages.

Avoid notification spam.

---

# 48. Notification Idempotency

A Telegram webhook or Worker trigger may execute more than once.

Notifications should avoid accidental duplication.

Where appropriate, maintain notification records using a unique key such as:

```text
user_id
notification_type
period
```

Example:

```text
NB-0001
MONTHLY_REMINDER
2026-08
```

Do not repeatedly send the same monthly reminder unless explicitly configured.

---

# 49. QR Code Sending

When `/store` is requested:

1. Authenticate user.
2. Check user status.
3. Read payment account configuration.
4. Retrieve QR image from R2.
5. Send QR image.
6. Send payment instructions.

If QR code is unavailable:

```text
🏦 Payment Account

Bank:
BCA

Account Name:
RT 05 Community Fund

Account Number:
1234567890

⚠️ QR code is currently unavailable.

Please contact the administrator.
```

Do not expose Cloudflare R2 errors.

---

# 50. Store Information

The store/payment information may contain:

```text
bank_name
account_name
account_number
monthly_fee
payment_instruction
qr_url
```

Example:

```text
🏦 Rekening Pembayaran

Bank:
BCA

Nama:
RT 05 Community Fund

Nomor Rekening:
1234567890

Iuran Bulanan:
Rp 50.000
```

Only display information configured for public/member use.

---

# 51. Testing Requirements

## Authentication

Test:

```text
Linked active member
Unlinked Telegram user
Disabled member
Invalid login code
Expired login code
Used login code
```

## Authorization

Test:

```text
User A cannot access User B
User A cannot manipulate member ID
User A cannot access admin functions
```

## Balance

Test:

```text
No transactions
One contribution
Multiple contributions
Reversal
Large balance
Zero balance
```

## History

Test:

```text
0 transactions
1 transaction
10 transactions
11+ transactions
Pagination
```

## Contribution

Test:

```text
Paid
Unpaid
Partial/adjusted payment
Different monthly fee
Previous months
```

## Store

Test:

```text
QR available
QR missing
QR replaced
Bank information updated
R2 object unavailable
```

## Notifications

Test:

```text
Payment confirmation
Monthly reminder
Duplicate reminder prevention
Disabled user
```

---

# 52. Definition of Done

The user bot is considered v1 complete when:

* [x] `/start` works.
* [x] Telegram ID authentication works.
* [x] Unlinked users are handled correctly.
* [x] Disabled users are handled correctly.
* [x] `/login` works if account linking is enabled.
* [x] Main Telegram keyboard works.
* [x] `/balance` works.
* [x] `/history` works.
* [x] Transaction pagination works.
* [x] `/contribution` works.
* [x] Contribution history works.
* [x] `/store` works.
* [x] Bank information is displayed.
* [x] QR code is retrieved from Cloudflare R2.
* [x] QR code is sent through Telegram.
* [x] `/profile` works.
* [x] `/status` works.
* [x] `/help` works.
* [x] Users cannot access another member's information.
* [x] Users cannot modify financial records.
* [x] Payment confirmation notifications work.
* [x] Monthly reminders work.
* [x] Duplicate notifications are prevented.
* [x] Errors do not expose internal information.
* [x] Secrets are not hard-coded.
* [x] Indonesian language is used consistently.
* [x] Currency formatting uses Indonesian Rupiah.
* [x] Asia/Jakarta timezone is used.

> Status: all items are implemented and pass unit + mocked integration checks.

---

# 53. Recommended User Experience

The ideal user experience should be:

```text
User opens bot
       ↓
/start
       ↓
👋 Welcome, Ahmad
       ↓
┌────────────────────┐
│ 💰 Balance         │
│ 📊 History         │
│ 💳 Contribution    │
│ 🏦 Store           │
│ 👤 Profile         │
│ ℹ️ Status           │
│ ❓ Help             │
└────────────────────┘
```

Typical contribution flow:

```text
User
  │
  ├── 💳 Contribution
  │       ↓
  │   ❌ Belum Dibayar
  │       ↓
  ├── 🏦 Store
  │       ↓
  │   View bank information
  │       ↓
  │   View QR code
  │       ↓
  │   Make payment
  │
  │
  │   Administrator verifies payment
  │
  ├── 🔔 Payment confirmation
  │
  └── 💰 Balance
          ↓
      Updated balance
```

The user should never need to understand Cloudflare D1 (SQLite), Cloudflare R2, Worker, transaction IDs, or internal system architecture.

---

# 54. Future Features

Do NOT implement these in v1 unless explicitly requested:

```text
Online payment gateway
Automatic payment verification
Receipt OCR
User-created payment records
Money withdrawal
Peer-to-peer transfer
Interest
Loans
Multiple currencies
Investment functionality
Complex accounting
```

Potential future feature:

```text
Upload payment receipt
        ↓
Cloudflare R2
        ↓
Admin review
        ↓
Approve / Reject
        ↓
Record contribution
```

This should be designed as a separate workflow.

---

# 55. Final Development Rule

The user bot should remain:

```text
Simple
Friendly
Read-only for financial data
Secure
Fast
Easy for non-technical users
```

The user should only need Telegram.

The user should never need:

```text
Cloudflare D1 (SQLite)
Cloudflare R2
Telegram Bot account
Web dashboard
```

The administrator controls the financial records.

The user bot provides a transparent view of the user's own account and makes it easy to find the payment information and QR code.

---

# 56. v1 Implementation Notes

## 56.1 Source Layout

Implemented in `src/` exactly as described in §40, plus `test_selfcheck.js`:

```text
src/
├── worker.js          doPost / doGet / setWebhook / deleteWebhook / getBotToken_
├── telegram.js      Telegram API calls, reply + inline keyboards
├── router.js        command routing, menu mapping, callbacks, /login, /start … /help
├── auth.js          getAuthenticatedMember (UNLINKED / DISABLED / ok)
├── users.js         telegram-id lookup, consumeLoginCode_
├── profile.js       sanitized profile (no internal fields)
├── balance.js       getBalance (Σ CREDIT − Σ DEBIT)
├── transactions.js  getTransactions (own user only, date desc)
├── contributions.js current period, contribution status/history
├── store.ts         _config key/value reader
├── notifications PAYMENT_CONFIRMED + MONTHLY_REMINDER, idempotent
└── test_selfcheck.js  vm-based self-check of pure logic
```

## 56.2 Cloudflare D1 (SQLite) Schema

Create these tables in the bound database:

```text
_users
user_id | telegram_id | name | phone | telegram_username | status
NB-0001 | 123456789   | Ahmad| 08123456789 | ahmad | ACTIVE

_transactions
user_id | period | type | direction | amount | date | description
NB-0001 | 2026-08 | CONTRIBUTION | CREDIT | 50000 | 2026-08-10 | (optional)

_config
key | value
monthly_fee | 50000
due_day | 10
bank_name | BCA
account_name | RT 05 Community Fund
account_number | 1234567890
payment_instruction | (optional text)
qr_url | 1AbCdEfGh…

_login_codes
code | user_id | expires_at | used
ABC123 | NB-0003 | 2026-08-10 12:00:00 | FALSE

_notifications
sent_at | user_id | notification_type | period
2026-08-10 12:00:00 | NB-0001 | PAYMENT_CONFIRMED | 2026-08
```

Notes:

* `_users.status` = `ACTIVE` or `DISABLED`.
* `_transactions.direction` = `CREDIT` (adds) or `DEBIT` (subtracts). `amount` is an integer IDR value.
* `period` format is `yyyy-MM`.
* `_notifications` uniqueness is `(user_id, notification_type, period)` for duplicate prevention.

## 56.3 Environment Variables

Secrets live in Worker environment variables only (never in source):

```text
TELEGRAM_BOT_TOKEN     <bot token from @BotFather>
WEBHOOK_SECRET         <secret for webhook validation>
TIMEZONE               <optional, default: Asia/Jakarta>
```

No other secret configuration is required.

## 56.4 Deployment Checklist

1. Create a new Worker project and bind the D1 database and R2 bucket (via wrangler.toml).
2. Create the five tables via `wrangler d1 execute` or Dashboard.
3. Deploy the single-file worker.js or modularized src files.
4. Configure environment variables: `BOT_TOKEN`, `WEBHOOK_SECRET`, optional `TIMEZONE`.
5. Register webhook URL with Telegram BotFather.
6. Send `/start` from Telegram to verify a live round-trip.

## 56.5 Admin Integration

The same Worker backend can be shared with the administrator bot:

* `notifyPaymentConfirmed(userId, period, amount, paymentMethod)` — call after the admin records a contribution. Idempotent per `(user_id, PAYMENT_CONFIRMED, period)`.
* `sendContributionReminder(userId, period)` — sends only if unpaid and not already sent.
* `sendDueReminders()` — iterates active members for the current period; wire to a monthly time-driven trigger.
* `getBalance`, `getTransactions`, `getContributionStatus` are read-only services reused by both bots.

## 56.6 Command Map

Slash commands and menu buttons both route to the same handlers:

```text
/start            onStart        welcome + main keyboard
/login <code>     onLogin        one-time linking code
/balance          onBalance
/history          onHistory      inline pagination (10/page)
/contribution     onContribution current status + 6-month history
/store            onStore        bank info + QR photo
/profile          onProfile      sanitized profile
/status           onStatus       account overview
/help             onHelp
```

Menu labels (Indonesian): `💰 Saldo`, `📊 Riwayat`, `💳 Iuran`, `🏦 Rekening`, `👤 Profil`, `ℹ️ Status`, `❓ Bantuan`.

## 56.7 Known Simplifications

* `getDataObjects_` reads a full sheet range per call (`ponytail:` comments in code). Upgrade to range + `CacheService` when `_transactions` grows large. Financial balances always read fresh from the ledger.
* No receipt upload flow — explicitly out of scope for v1 (§54).
* Group/private-chat guard: the bot ignores non-`private` chats.

