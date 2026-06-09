---
name: financial-data-parsing
description: "Best practices for parsing financial/billing data (bank PDFs, payment CSVs, transaction records). Use when processing bank statements, payment records, billing data, or any task involving financial transaction parsing and analysis. Keywords: 财务, 解析, 银行, PDF, 账单, 交易记录, 支付, financial, billing, transaction, statement."
---

# Financial Data Parsing Guide

Best practices derived from real-world financial data parsing tasks. This skill helps avoid common pitfalls when processing bank statements, payment records, and transaction data.

## Pre-Flight Checklist

Before writing any parsing code, complete these steps **in order**:

### 1. Enumerate ALL Data Sources

Scan the entire working directory for data files before starting:

```bash
find . -type f \( -name '*.csv' -o -name '*.pdf' -o -name '*.xlsx' -o -name '*.xls' -o -name '*.ofx' \) | sort
```

- List every file found and confirm with the user that the list is complete
- Ask: "Are there any other data sources I should include?"
- Note the file count and total size — report this to the user

### 2. Identify Account Structure

Before parsing, identify all accounts from file names and headers:

- Different bank cards (check card number suffixes in PDF headers)
- Different platforms (WeChat Pay, Alipay, bank apps)
- Different account types (debit, credit, savings)

Confirm with the user: "I found N accounts: [list]. Is this correct?"

### 3. Define Expected Output Schema

Show the user the planned output schema before coding:

```
Transaction:
  - date: YYYY-MM-DD
  - amount: float (positive for income, negative for expense)
  - counterparty: string (may be empty)
  - description: string
  - account_id: string
  - category: string
  - is_internal_transfer: boolean
```

## Parsing Rules

### PDF Parsing: Use Table Extraction, NOT Regex

**Never use regex for structured PDF parsing.** Use table extraction:

```python
import pdfplumber

def parse_bank_pdf(pdf_path):
    transactions = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                if not table or len(table) < 2:
                    continue
                # Find header row
                header_idx = find_header_row(table)
                if header_idx is None:
                    continue
                # Parse data rows
                for row in table[header_idx + 1:]:
                    parsed = parse_table_row(row)
                    if parsed:
                        transactions.append(parsed)
    return transactions
```

### Account Identification

Extract account info from PDF header lines (first ~30 lines):

```python
def identify_account(lines):
    for line in lines[:30]:
        if '尾号' in line:
            # Extract card suffix
            return extract_card_suffix(line)
    return 'unknown'
```

### Flexible Row Parsing

Rows may have missing fields. Use per-field extraction, not a single regex:

```python
def parse_table_row(row):
    # Each field extracted independently
    date = extract_date(row)
    amount = extract_amount(row)
    counterparty = extract_counterparty(row)  # May be None
    description = extract_description(row)

    if not date or amount is None:
        return None  # Skip invalid rows but log them

    return {
        'date': date,
        'amount': amount,
        'counterparty': counterparty or '',
        'description': description,
    }
```

## Internal Transfer Detection

Mark these transaction types as internal transfers (not income/expense):

| Pattern | Description |
|---------|-------------|
| 银证转账 | Bank ↔ securities account |
| 第三方存管 | Third-party depository transfer |
| 本人同名转账 | Transfer between own accounts |
| 快捷支付 | Quick pay (tracked on platform side) |
| 信用卡还款 | Credit card repayment |
| 零钱充值/提现 | Wallet top-up / withdrawal |

```python
INTERNAL_TRANSFER_PATTERNS = [
    '银证转账', '第三方存管', '证券',
    '信用卡还款', '还款',
    '充值', '提现',
    '零钱通', '余额宝',
]

def is_internal_transfer(description, counterparty='', user_name=''):
    if counterparty == user_name:
        return True
    return any(p in description for p in INTERNAL_TRANSFER_PATTERNS)
```

## Cross-Platform Deduplication

Bank card "quick pay" transactions appear on both bank statements and payment platform records. Deduplicate with tolerance:

```python
def find_cross_platform_duplicates(bank_txns, platform_txns):
    duplicates = []
    for bt in bank_txns:
        if '快捷支付' not in bt.get('description', ''):
            continue
        for pt in platform_txns:
            # Allow time difference up to 5 minutes
            time_diff = abs((bt['date'] - pt['date']).total_seconds())
            # Allow amount difference up to 1 yuan (fees)
            amount_diff = abs(bt['amount'] - pt['amount'])
            if time_diff < 300 and amount_diff < 1.0:
                duplicates.append((bt, pt))
    return duplicates
```

## Data Validation Checklist

After parsing, run ALL of these checks and report results to the user:

| Check | Method |
|-------|--------|
| Record count matches source | Count rows vs parsed transactions |
| Date range covers full period | Min/max date vs expected range |
| All accounts present | Verify each identified account has data |
| Income/expense totals reasonable | Compare with user's expectations |
| No duplicate records | Check for same date+amount+description |
| Internal transfers correctly excluded | Verify known transfers are marked |

```python
def validate_and_report(transactions):
    print(f"Total records: {len(transactions)}")
    print(f"Date range: {min(t['date'] for t in txs)} ~ {max(t['date'] for t in txs)}")
    print(f"Accounts: {set(t['account_id'] for t in transactions)}")

    income = sum(t['amount'] for t in transactions if t['amount'] > 0 and not t['is_internal_transfer'])
    expense = sum(t['amount'] for t in transactions if t['amount'] < 0 and not t['is_internal_transfer'])
    transfers = sum(1 for t in transactions if t['is_internal_transfer'])

    print(f"Income total: ¥{income:,.2f}")
    print(f"Expense total: ¥{abs(expense):,.2f}")
    print(f"Internal transfers excluded: {transfers}")

    # ALWAYS show this to the user for confirmation
    print("\nPlease verify these numbers match your expectations.")
```

## Common Pitfalls

| Pitfall | Prevention |
|---------|------------|
| Only finding some data files | Pre-flight enumeration with user confirmation |
| Regex too strict, skipping records | Use table extraction, per-field parsing |
| Missing accounts | Identify all card numbers before parsing |
| Internal transfers counted as income | Check against transfer pattern list |
| Cross-platform duplicates | Time+amount tolerance matching |
| Ignoring user feedback | Re-run validation, compare with expectations |

## User Feedback Response Protocol

When user says data is wrong:

1. **Don't just patch** — re-examine the entire pipeline
2. **Compare source vs parsed** — check record counts per file
3. **Ask specific questions** — "Which account/period seems off?"
4. **Show validation summary** — after every fix, re-run all checks
5. **Be transparent** — report what was wrong and what changed
