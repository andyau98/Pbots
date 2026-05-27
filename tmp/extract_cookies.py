import browser_cookie3 as bc3
import warnings
import os
import sys

warnings.filterwarnings('ignore')

print("=" * 60)
print("Gemini Cookie Extractor")
print("=" * 60)
print(f"Running as: {os.environ.get('USERNAME', 'unknown')}")
print(f"Admin: {os.environ.get('ADMIN', 'unknown')}")
print()

# Try Chrome
print("Trying Chrome...")
try:
    jar = bc3.chrome(domain_name='gemini.google.com')
    cookies = list(jar)
    print(f"Found {len(cookies)} cookies")
    for c in cookies:
        if '1PSID' in c.name or 'SIDTS' in c.name:
            print(f"  ✅ {c.name}={c.value[:50]}...")
    if not any('PSID' in c.name for c in cookies):
        print("  No Gemini auth cookies found")
        for c in cookies[:5]:
            print(f"  {c.name}: {c.value[:30]}")
except Exception as e:
    print(f"  ❌ {type(e).__name__}: {e}")

# Try Edge
print("\nTrying Edge...")
try:
    jar = bc3.edge(domain_name='gemini.google.com')
    cookies = list(jar)
    print(f"Found {len(cookies)} cookies")
    for c in cookies:
        if '1PSID' in c.name or 'SIDTS' in c.name:
            print(f"  ✅ {c.name}={c.value[:50]}...")
except Exception as e:
    print(f"  ❌ {type(e).__name__}: {e}")

print("\nDone.")
