import json,sys
d=json.load(open(sys.argv[1]))
print('rules',d['rules'])
for m,v in d['models'].items():
  print(m,v)
  for k,c in d['perCase'].items():
    x=c.get(m)
    if x: print(' ',k,c['rules'],'->',x['fallback'],'| alone',x.get('alone'),repr(x.get('aloneSyntax')))
