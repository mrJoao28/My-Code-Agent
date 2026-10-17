import ts from 'typescript';
for await (const path of new Bun.Glob('packages/cui/src/**/*.tsx').scan('.')) {
 if(path.includes('.test.')) continue;
 const source=ts.createSourceFile(path,await Bun.file(path).text(),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 function visit(node: ts.Node) {
  if(ts.isJsxText(node)) {
   const parent=node.parent;
   const tag=ts.isJsxElement(parent)?parent.openingElement.tagName.getText(source):'fragment';
   const text=node.text;
   if(!['text','span','em','b','i','u','a'].includes(tag) && (text.trim() || !/[\r\n]/.test(text))) console.log(path,source.getLineAndCharacterOfPosition(node.pos).line+1,tag,JSON.stringify(text));
  }
  ts.forEachChild(node,visit);
 }
 visit(source);
}
