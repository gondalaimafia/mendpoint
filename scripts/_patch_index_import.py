from pathlib import Path
import re

p = Path("packages/codebase-index/src/index.ts")
t = p.read_text(encoding="utf-8")
if "ts-frontend" in t:
    print("already patched")
else:
    t2, n = re.subn(
        r'\} from "@mendpoint/call-graph";\s*\n+',
        '} from "@mendpoint/call-graph";\n'
        "import {\n"
        "  extractWithTypescript,\n"
        "  isTypescriptFile,\n"
        "  loadTypescriptSync,\n"
        '} from "./ts-frontend.js";\n\n',
        t,
        count=1,
    )
    if n != 1:
        raise SystemExit(f"patch failed n={n}")
    p.write_text(t2, encoding="utf-8")
    print("patched")
