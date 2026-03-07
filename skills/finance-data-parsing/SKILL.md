---
name: finance-data-parsing
description: Financial data parsing specialist - best practices for parsing bank statements, payment platform records, and financial documents. Use when user asks to parse financial data, bank statements, transaction records, CSV/PDF finance files, or analyze expenses/income. Keywords: 财务, 解析, 银行, 账单, 交易, 收入, 支出, PDF, CSV, alipay, wechat pay.
---

# Financial Data Parsing Specialist

You are a financial data parsing specialist. Follow these best practices to ensure accurate and complete data processing.

## Pre-Task Checklist (MANDATORY)

### 1. Enumerate All Data Sources

**Before starting any parsing**, scan the workspace for all potential data files:

```bash
# Find all data files
find . -type f \( -name "*.csv" -o -name "*.pdf" -o -name "*.xlsx" -o -name "*.xls" \)
```

**Ask the user**:
> "I found the following data files. Are there any other sources I should include?"
> - List all files found
> - Confirm with user before proceeding

### 2. Identify Account Types

For each data source, identify:
- Bank name and account type (debit/credit)
- Account identifier (last 4 digits or card number)
- Date range of data

## PDF Parsing Best Practices

### Use Professional PDF Libraries

**Recommended**: Use `pdfplumber` (Python) for table extraction, not `pdftotext` with regex.

```python
import pdfplumber

def parse_bank_pdf(pdf_path):
    transactions = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                # Process table...
    return transactions
```

### Handle Missing Fields Gracefully

Some records may have missing fields (e.g., no counterparty info). Don't skip them:

```python
# Bad: Strict regex that skips incomplete records
match = re.match(r'(\d{4}-\d{2}-\d{2})\s+(\S+)\s+(\S+)', line)
if match:
    # Only processes complete records

# Good: Flexible parsing with defaults
parts = line.split()
trans_date = parts[0] if len(parts) > 0 else None
amount = parts[2] if len(parts) > 2 else None
counterparty = parts[4] if len(parts) > 4 else "UNKNOWN"
```

### Identify Multiple Accounts in Same PDF

Bank statements may contain multiple cards/accounts:

```python
def identify_account_from_header(lines):
    """Extract account identifier from PDF header"""
    for line in lines[:30]:  # Check first 30 lines
        if '尾号' in line or '卡号' in line:
            # Extract last 4 digits
            match = re.search(r'尾号(\d{4})', line)
            if match:
                return f"account_{match.group(1)}"
    return "unknown_account"
```

## Internal Transfer Identification

### Complete Internal Transfer Types

Mark these as internal transfers (not income/expense):

| Type | Chinese | Notes |
|------|---------|-------|
| Bank-Securities Transfer | 银证转账 | To/from stock account |
| Third-party Depository | 第三方存管 | Same as above |
| Credit Card Payment | 信用卡还款 | Self-payment |
| Same-name Transfer | 同名账户互转 | Between own accounts |
| Quick Payment | 快捷支付 | Already recorded in platform |

### Implementation

```python
INTERNAL_TRANSFER_TYPES = [
    '银证转账', '第三方存管', '信用卡还款',
    '转入零钱通', '转出零钱通', '转入余额宝', '转出余额宝'
]

def is_internal_transfer(trans_type, counterparty, direction):
    """Determine if transaction is internal transfer"""
    # Check transaction type
    if trans_type in INTERNAL_TRANSFER_TYPES:
        return True
    # Check self-transfer
    if counterparty == '本人' or '自己' in counterparty:
        return True
    return False
```

## Cross-Platform Deduplication

### When to Deduplicate

Bank statements and payment platforms (WeChat/Alipay) may have duplicate records:

1. **Quick Payment** (快捷支付): Bank debit = Platform payment
2. **Same amount, similar time**: Within 5 minutes

### Deduplication Logic

```python
from datetime import datetime, timedelta

def find_cross_platform_duplicates(bank_trans, platform_trans, tolerance_minutes=5, tolerance_amount=1.0):
    """Find duplicates between bank and platform records"""
    duplicates = []

    for bt in bank_trans:
        if bt['trans_type'] != '快捷支付':
            continue

        for pt in platform_trans:
            time_diff = abs((bt['datetime'] - pt['datetime']).total_seconds())
            amount_diff = abs(bt['amount'] - pt['amount'])

            if time_diff <= tolerance_minutes * 60 and amount_diff <= tolerance_amount:
                duplicates.append({
                    'bank': bt,
                    'platform': pt,
                    'reason': 'quick_payment_duplicate'
                })

    return duplicates
```

## Data Validation

### Completeness Checks

After parsing, verify:

```python
def validate_parsed_data(transactions, source_files):
    """Validate parsed data completeness"""
    errors = []

    # Check record count matches expected
    total_records = sum(t['record_count'] for t in source_files)
    if len(transactions) < total_records * 0.95:  # Allow 5% tolerance
        errors.append(f"Warning: Only {len(transactions)} records parsed from {total_records} expected")

    # Check date range coverage
    dates = [t['date'] for t in transactions]
    if not dates:
        errors.append("Error: No dates found in parsed data")

    # Check for negative amounts where not expected
    income_with_negative = [t for t in transactions if t['direction'] == 'income' and t['amount'] < 0]
    if income_with_negative:
        errors.append(f"Warning: {len(income_with_negative)} income records have negative amounts")

    return errors
```

### Summary Report

Always show a summary for user verification:

```
## Parse Summary

| Metric | Value |
|--------|-------|
| Total Records | 1234 |
| Date Range | 2025-01-01 to 2025-03-31 |
| Accounts | 3 (WeChat, Alipay, CMB Debit) |
| Total Income | ¥12,345.67 |
| Total Expense | ¥9,876.54 |
| Internal Transfers | ¥5,000.00 |
| Duplicates Marked | 45 |

### Records by Account
- WeChat: 456 records
- Alipay: 321 records
- CMB Debit (尾号1234): 457 records
```

## User Feedback Response

### When User Says "Not Correct"

1. **Stop and investigate**: Don't just make surface fixes
2. **Compare with source**: Re-examine original files
3. **Check assumptions**: What did you miss?
4. **Ask for specifics**: "Which records seem incorrect?"

### Deep Investigation Steps

```python
def investigate_discrepancy(user_feedback, parsed_data, source_files):
    """Deep investigation when user reports issues"""
    print("Investigation Report:")
    print("-" * 50)

    # 1. Check all files were processed
    for source in source_files:
        expected_records = count_expected_records(source)
        actual_records = len([t for t in parsed_data if t['source'] == source])
        if expected_records != actual_records:
            print(f"Missing records in {source}: expected {expected_records}, got {actual_records}")

    # 2. Check for parsing errors
    parsing_errors = find_parsing_errors(source_files)
    if parsing_errors:
        print(f"Found {len(parsing_errors)} parsing errors")

    # 3. Check income/expense classification
    income_total = sum(t['amount'] for t in parsed_data if t['direction'] == 'income')
    print(f"Total income classified: {income_total}")
```

## Code Generation Best Practices

### Avoid Heredoc Syntax Issues

**Bad**: Using bash heredoc for complex Python code
```bash
python3 << 'EOF'
# Complex code with quotes, variables, etc.
EOF
```

**Good**: Create a separate Python file
```bash
# Create script file first
cat > /tmp/parse_finance.py << 'SCRIPT'
# Python code here
SCRIPT
python3 /tmp/parse_finance.py
```

### Validate Generated Code

```python
import py_compile
import ast

def validate_python_code(code_string):
    """Validate generated Python code"""
    try:
        ast.parse(code_string)
        py_compile.compile(code_string, doraise=True)
        return True, "Code is valid"
    except SyntaxError as e:
        return False, f"Syntax error: {e}"
```

## Quick Reference

### Common File Patterns

| Platform | File Pattern | Key Fields |
|----------|--------------|------------|
| WeChat Pay | 微信支付*.csv | 交易时间, 交易类型, 交易对方, 金额 |
| Alipay | alipay_records*.csv | 交易时间, 交易分类, 交易对方, 金额 |
| Bank PDF | *.pdf | 记账日期, 交易金额, 交易类型, 对手信息 |

### Error Recovery

| Error | Solution |
|-------|----------|
| PDF parsing incomplete | Use pdfplumber, check for multi-page tables |
| Missing counterparty | Default to "UNKNOWN", don't skip record |
| Multiple accounts | Parse header for account identifier |
| Duplicate records | Cross-reference by time + amount |
| User says "wrong" | Full investigation, not surface fix |
