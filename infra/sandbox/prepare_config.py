"""Create local control-plane configuration without displaying credentials."""
import argparse
import json
from pathlib import Path
import secrets

parser = argparse.ArgumentParser()
parser.add_argument("--directory", required=True, type=Path)
options = parser.parse_args()
directory = options.directory.resolve()
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
config = directory / "config.toml"
key_path = directory / "control-key"
if config.exists() or key_path.exists():
    raise SystemExit("Configuration already exists; refusing to replace it.")
key = secrets.token_urlsafe(32)
template = Path(__file__).with_name("server.example.toml").read_text()
rendered = template.replace('"__GENERATE_LOCALLY__"', json.dumps(key)).replace(
    '"__STATE_DIR__/store.db"', json.dumps(str(directory / "store.db"))
)
for path, content in ((key_path, key + "\n"), (config, rendered)):
    with path.open("x") as output:
        path.chmod(0o600)
        output.write(content)
print("Private OpenSandbox configuration created; credentials were not displayed.")
