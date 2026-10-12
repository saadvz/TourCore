"""Reproduce the inspected local checkpoints; no runtime code is executed."""
import hashlib
import json
from pathlib import Path
from huggingface_hub import snapshot_download
from huggingface_hub.utils import disable_progress_bars

PACKAGES={
 'd3-edge':('18d61df78684675463af9ae732872478845c5a79','2eb3066c44c11555eef253c7f4f3c749e4e6f88863b2dcd1268b276c7b89611c'),
 'd3-lite':('a8d25a91ef75552803f7009d25b7bd435991abd9','810a04f3e6979adb2289aa8fc151155bf8fd2c2bc33a60248d33238632b22716'),
 'd3-nano':('3aeb1c22a5632aac72353c36b3d0111c40e7dbf4','1e5d4d276d908e1acfd1caf71dd0f39f9280bed3dc7ad3e8727edb0371956147')}
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for b in iter(lambda:stream.read(16<<20),b''):h.update(b)
 return h.hexdigest()
def verify(root,manifest_hash):
 if digest(root/'MODEL_MANIFEST.json')!=manifest_hash:raise ValueError('Checkpoint manifest differs from inspected revision')
 manifest=json.loads((root/'MODEL_MANIFEST.json').read_text())
 if manifest['schema']!='d3-package-manifest/1':raise ValueError('Unknown manifest schema')
 for name,expected in manifest['files_sha256'].items():
  if Path(name).is_absolute() or '..' in Path(name).parts:raise ValueError('Invalid manifest path')
  p=root/name
  if p.stat().st_size!=manifest['files_bytes'][name] or digest(p)!=expected:raise ValueError('Checkpoint file failed verification')
disable_progress_bars()
for model,(revision,manifest_hash) in PACKAGES.items():
 root=Path('/workspace/cleaner-phase04-models')/model
 try:verify(root,manifest_hash)
 except (OSError,ValueError):
  snapshot_download(repo_id='vllm-sr/'+model,revision=revision,local_dir=root,token=False,max_workers=4)
  verify(root,manifest_hash)
 print(model,revision,'full SHA-256 verification passed',flush=True)
