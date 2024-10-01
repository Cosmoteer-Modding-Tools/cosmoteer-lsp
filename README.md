Based on https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample

## This is NOT a official extension from the Cosmoteer Team

# Cosmoteer Language Server

This is a language server for the game Cosmoteer. Its goal is to provides code completion, hover information, migrations, cli, theming and diagnostics for Cosmoteer modding files (\*.rules).
For now its only support basic syntax highlighting and diagnostics.

### How to use

Set the `cosmoteerPath` setting to the path of your Cosmoteer installation. This is needed to validate references and assets for this language server, if you don't set it.
If you have custom references which can't yet be resolved by the language server, you can add them to the `ignoredPaths` setting. This is an array of strings which will ingore every path which includes the String specified in it.
Please be aware that the language server at the moment only checks the file which is currently open and not the whole workspace.

## Suggestions

Please be aware that this extension does not provide `abc`(You can see those icons or text left from the suggested text) suggestions those are by vs code itself. If you see a file icon with a `->`in the top corner of this file icon. Than this is a suggestion from the language server.
To generate those suggestions you can use the `ctrl+space` keybinding to get the suggestions from the language server. Unless you changed it in the settings.

### Features until now

-   Basic syntax highlighting
-   Provide diagnostics for syntax errors
-   Code completion for & references in the same parent scope
-   Validation for references for .rules files
-   Validation for function calls, math expressions and assignments with references
-   localisation support (en, de) so far

### Features in the future

-   Validation for assets (e.g. images, sounds, shaders) (**With the next release v0.4.0**)
-   Code completion for assets
-   Code completion for functions (Needs type checking)
-   Code completion for all references (**With the next release v0.4.0**)
-   Reference Validation for mod.rules (**With the next release v0.4.0**)
-   Respecting additions/inheritances/deletions `Actions` of mod.rules files
-   Code formatting
-   Type checking
-   Identifer validation
-   Renaming/Refactoring across files
-   Multi root workspace support
-   Validate all `.rules` in the workspace
-   _If you have any suggestions or ideas, please open a issue on the [GitHub](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/issues)_

### Showcase

![Basic Syntax Highlighting Example Image](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/syntax_highlighting.png?raw=true)
![Diagnostics for syntax errors Example Image](https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/showcase/diagnostics.png?raw=true)

https://github.com/user-attachments/assets/b1de7a49-404f-483b-8739-f1e7b6706a50
