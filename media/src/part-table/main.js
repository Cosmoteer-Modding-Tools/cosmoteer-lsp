// The part table webview: draws the row-and-column payload the server builds out of the project's
// parts. It knows nothing about Cosmoteer. Every value in it was resolved and computed on the
// server, so this page only sorts, filters, groups and compares what it is given.
//
// IDE-agnostic: VS Code provides acquireVsCodeApi natively, the JetBrains plugin shims it and
// replays host messages as MessageEvents after the page posts {type:'ready'}.

import { headerOf, headersFor, parseTyped } from './headers.js';
import { startPage } from './host.js';

// A webview hands the page its host bridge and a Node unit test that loads the bundle for the pure
// helpers below does not. Nothing this page imports touches the document while it is being read, so
// the helpers can be had without the page being started.
if (typeof acquireVsCodeApi !== 'undefined') startPage();

export { headerOf, headersFor, parseTyped };
