import subprocess
import sys

result = subprocess.run(
    ['npm', 'run', 'build'],
    capture_output=True,
    text=True,
    cwd='C:/akhil/git/apra-fleet'
)
print(result.stdout[-3000:] if result.stdout else '')
print(result.stderr[-3000:] if result.stderr else '')
print('EXIT:', result.returncode)
sys.exit(result.returncode)
