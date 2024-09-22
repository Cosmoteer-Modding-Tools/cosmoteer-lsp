Based on https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample

## This is NOT a official extension from the Cosmoteer Team

# Cosmoteer Language Server

This is a language server for the game Cosmoteer. Its goal is to provides code completion, hover information, migrations, cli, theming and diagnostics for Cosmoteer modding files (\*.rules).
For now its only support basic syntax highlighting and diagnostics.

### How to use
Set the `cosmoteerPath` setting to the path of your Cosmoteer installation. This is needed to validate references and assets for this language server, if you don't set it.

### Features until now

-   Basic syntax highlighting
-   Provide diagnostics for syntax errors
-   Code completion for & references in the same parent scope
-   Validation for references for .rules files
-   Validation for function calls, math expressions and assignments with references
-   localisation support (en, de) so far

### Showcase
![Basic Syntax Highlighting Example Image](https://github.com/TrustNoOneElse/cosmoteer-lsp/blob/master/showcase/syntax_highlighting.png?raw=true)
![Diagnostics for syntax errors Example Image](https://github.com/TrustNoOneElse/cosmoteer-lsp/blob/master/showcase/diagnostics.png?raw=true)

https://github.com/user-attachments/assets/b1de7a49-404f-483b-8739-f1e7b6706a50

