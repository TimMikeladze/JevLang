"""Run offline: python3 examples/image_localization.py
To ask Jev: TYPESAFE_API_KEY=... python3 examples/image_localization.py image.png
"""
import json
import sys
from pathlib import Path
from jevlang import Policy, noul, box, gate, escalate, rule, all_of, compute, assign, hold, image_asset

present = noul('present', 'Is there a mug in the image referenced by `photo`?')
mug = box('mug', 'Locate the mug in the image referenced by `photo`.')
policy = Policy(name='localize-mug', typesafe={'experimental': {'images': True}},
                questions=[present, mug], gates=[gate(mug, .8, escalate('review'), onRead=True)],
                route={'clauses': [rule(all_of(present.yes(.9), compute('lt', mug.left(), .5)),
                                        assign('found', data=mug.value()))], 'otherwise': hold()})

if __name__ == '__main__':
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
        decision = policy.evaluate({'photo': 'mug-image'}, assets={'mug-image': image_asset(path.read_bytes(), format=path.suffix.lstrip('.').lower())})
    else:
        decision = policy.decide({'present': {'type': 'noul', 'noul': .99},
                                  'mug': {'type': 'box', 'box': {'left': .1, 'right': .8, 'top': .2, 'bottom': .9}, 'confidence': .95}})
    print(json.dumps(decision, indent=2))
