import re

content = open('src/components/Library.jsx', 'rb').read()
text = content.decode('utf-8')

# Garbling indicator codepoints (non-Polish chars that appear from cp1250 mojibake)
GARBLE_CODEPOINTS = {
    0x0139,  # Ĺ (L with Acute) - garbled ł
    0x0102,  # Ă (A with Breve) - garbled ó prefix
    0x201A,  # ‚ (single low-9 quote) - garbled continuation byte
    0x201E,  # „ (double low-9 quote) - garbled continuation byte
    0x0192,  # ƒ - garbled
    0x02C7,  # ˇ (caron)
    0x2021,  # ‡ (double dagger) - garbled ć suffix
    0x0161,  # š (s with caron) - garbled
}

def fix_cp1250(s):
    result = b''
    for ch in s:
        try:
            result += ch.encode('cp1250')
        except UnicodeEncodeError:
            result += ch.encode('utf-8')
    try:
        return result.decode('utf-8')
    except:
        return None

def is_garbled(s):
    return any(ord(ch) in GARBLE_CODEPOINTS for ch in s)

def fix_string(s):
    if not is_garbled(s):
        return s
    fixed1 = fix_cp1250(s)
    if fixed1 is None:
        return s
    if not is_garbled(fixed1):
        return fixed1
    # Try double fix
    fixed2 = fix_cp1250(fixed1)
    if fixed2 and not is_garbled(fixed2):
        return fixed2
    return fixed1

# Find all double-quoted string literals and backtick template strings
pattern = re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"', re.DOTALL)

replacements = []
for m in pattern.finditer(text):
    s = m.group(1)
    if is_garbled(s):
        fixed = fix_string(s)
        if fixed != s:
            line = text[:m.start()].count('\n') + 1
            replacements.append((m.start(1), m.end(1), s, fixed))
            print(f'Line {line}: "{s}" -> "{fixed}"')

print(f'\nTotal: {len(replacements)} strings to fix')

# Apply fixes (in reverse order to preserve offsets)
result = text
for start, end, old, new in reversed(replacements):
    result = result[:start] + new + result[end:]

# Write fixed file
with open('src/components/Library.jsx', 'w', encoding='utf-8') as f:
    f.write(result)

print('Written fixed file.')
