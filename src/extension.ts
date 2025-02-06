import * as path from 'path';
const aliases: Record<string, string> = {
	'@shared': path.resolve(__dirname, '..', 'shared', 'src')
};

import * as _Module from 'module';
const Module = _Module as any as { _resolveFilename: (request: string, parent: NodeModule, isMain: boolean, options?: any) => string };

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = (request, parent, isMain, options) => {
	if (request.startsWith('@')) {
        const parts = request.split('/');
		const alias = aliases[parts[0]];
		if (alias)
			request = [alias, ...parts.slice(1)].join('/');
    }
    return originalResolveFilename(request, parent, isMain, options);
};

import * as vscode from 'vscode';
import {promises as fs} from 'fs';
import * as sharp from 'sharp';
import * as utils from '@shared/utils';

//import * as vm from 'vm';
//import { WasmContext, Memory } from '@vscode/wasm-component-model';

interface ThemeIcon {
	iconPath: string;
}

interface IconTheme {
	iconDefinitions:	Record<string, ThemeIcon>;
	fileNames:			Record<string, string>;
}
/*
file:	                    string;
folder:	                    string;
folderExpanded:	            string;
rootFolder:	                string;
rootFolderExpanded:	        string;
folderNames:	            Record<string, string>
folderNamesExpanded:	    Record<string, string>
rootFolderNames:	        Record<string, string>
rootFolderNamesExpanded:	Record<string, string>
languageIds:	            Record<string, string>
fileExtensions:	            Record<string, string>
fileNames:	                Record<string, string>
*/

type Handler = (file: vscode.Uri, dest: vscode.Uri, name: string) => Promise<string>;

const handlers : Record<string, Handler> = {};

handlers['svg'] = async (file: vscode.Uri, dest: vscode.Uri, name: string) => {
	await vscode.workspace.fs.copy(
		file,
		vscode.Uri.joinPath(dest, name),
		{ overwrite: true }
	).then(undefined, reason => console.log(reason));
	return name;
};

const sharp_handler = async (file: vscode.Uri, dest: vscode.Uri, name: string) => {
	const out = path.join(dest.fsPath, name);
	try {
        await fs.unlink(out);
    } catch (err: any) {
        if (err.code !== 'ENOENT')
            console.log(`Error deleting file: ${err}`);
    }
	try {
		await sharp(file.fsPath).resize(16, 16, {fit: 'contain', background: {r:0, g:0, b:0, alpha:0}}).toFile(out);
    } catch (err: any) {
		console.log(`Error saving file: ${err}`);
    }
	return name;
}

handlers['png'] = sharp_handler;
handlers['jpg'] = sharp_handler;
handlers['gif'] = sharp_handler;

function toRegExp(pattern: string) {
	let re = "", range = false, block = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		switch (c) {
			default:	re += c; break;
			case ".":
			case "/":
			case "\\":
			case "$":
			case "^":	re += "\\" + c; break;
			case "?":	re += "."; break;
			case "[":	re += "["; range = true; break;
			case "]":	re += "]"; range = false; break;
			case "!":	re += range ? "^" : "!"; break;
			case "{":	re += "("; block = true; break;
			case "}":	re += ")"; block = false; break;
			case ",":	re += block ? "|" : "\\,"; break;
			case "*":
				if (pattern[i + 1] === "*") {
					re += ".*";
					i++;
					if (pattern[i + 1] === "/" || pattern[i + 1] === "\\")
						i++;
				} else {
					re += "[^/\\\\]*";
				}
				break;
		}
	}
	return re;
}

class Ignores {
	private patterns: string[] = [];
	private regexp: RegExp	= /.*$/;

	constructor(ignore?: string) {
		if (ignore)
			this.add(ignore);
	}
	add(ignore: string) {
		utils.arrayAppend(this.patterns, ignore.split(/\r?\n/).map(pattern => toRegExp(pattern)).filter(Boolean));
		const re = this.patterns.length > 1
			? '(' + this.patterns.join('|') + ')'
			: this.patterns[0];
		this.regexp = new RegExp(re + '$');
	}
	public test(input: string): boolean {
		return this.regexp?.test(input) ?? false;
	}
}

function with_dir(dirname: string, name: string) {
	return dirname ? `${dirname}/${name}` : name;
}

async function time_stamp(uri: vscode.Uri) {
	return vscode.workspace.fs.stat(uri).then(
		stat	=> stat.mtime,
		reason	=> 0//console.log(reason)
	);
}

async function updateIconTheme(themeFile: vscode.Uri, always: boolean) {
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	statusBarItem.text = "$(sync~spin) Updating thumbnail icons...";
	statusBarItem.show();

	const themeDir	= themeFile.with({path: path.dirname(themeFile.path)});

	const theme: IconTheme = await vscode.workspace.fs.readFile(themeFile).then(
		buffer => JSON.parse(buffer.toString()),
		() => ({
			iconDefinitions:	{},
			fileNames:			{}
		})
	);

	const workspace		= vscode.workspace.workspaceFolders![0].uri;
	const themeTime 	= await time_stamp(themeFile);

	const make_thumbnail = async (file: vscode.Uri, dest: vscode.Uri, dirname: string, name: string) => {
		for (let dot = -1; (dot = name.indexOf('.', dot + 1)) >= 0;) {
			const handler = handlers[name.slice(dot + 1)];
			if (handler) {
				const filename	= with_dir(dirname, name);
				const oldid		= theme.fileNames[filename];
				if (oldid) {
					const t0 = await time_stamp(vscode.Uri.joinPath(themeDir, theme.iconDefinitions[oldid].iconPath));
					const t1 = await time_stamp(file);
					if (t0 >= t1)
						return false;
				}
				await vscode.workspace.fs.createDirectory(dest);
				const icon	= await handler(file, dest, name);
				const id	= dirname ? `${dirname}-${icon}` : icon;
				theme.iconDefinitions[id]	= { iconPath: with_dir(dirname, icon) };
				theme.fileNames[filename]	= id;
				return true;
			}
		}
		return false;
	};

	const scan = async (dir: vscode.Uri, dirname: string, ignores: Ignores) => {
		console.log(dir.toString(true));
		const entries = await vscode.workspace.fs.readDirectory(dir);
		const ignore = entries.find(([name, type]) => name==='.gitignore');
		if (ignore) {
			ignores = utils.clone(ignores);
			ignores.add(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, ignore[0]))).toString());
		}

		const iconDir2 = vscode.Uri.joinPath(themeDir, dirname);
		return utils.asyncMap(entries, async ([name, type]) => {
			if (ignores.test(name))
				return;

			if (type === vscode.FileType.File) {
				await make_thumbnail(vscode.Uri.joinPath(dir, name), iconDir2, dirname, name);

			} else if (type === vscode.FileType.Directory) {
				const t1 = await time_stamp(vscode.Uri.joinPath(dir, name));
				if (t1 > themeTime)
					await scan(vscode.Uri.joinPath(dir, name), name, ignores);
			}
		});
	};

	const write_theme = async () => {
		//(theme.processedWorkspaces ??= {})[workspace.fsPath] = Date.now();
		await vscode.workspace.fs.writeFile(themeFile, Buffer.from(JSON.stringify(theme, null, 2)));
		const entries	= await vscode.workspace.fs.readDirectory(themeDir);
		const all		= await utils.asyncMap(entries.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json') && name !== 'thumbnails.json'),
			async ([name, type]) => vscode.workspace.fs.readFile(vscode.Uri.joinPath(themeDir, name)).then(
				buffer => JSON.parse(buffer.toString()),
				() => ({})
			)
		);
		const merged	= utils.merge(...all);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(themeDir, 'thumbnails.json'), Buffer.from(JSON.stringify(merged, null, 2)));
	};

	if (always || await time_stamp(workspace) > themeTime) {
		await scan(workspace, '', new Ignores('.git'));
		await write_theme();
	}

	let timeout: ReturnType<typeof setTimeout> | null = null;

	const update = (uri: vscode.Uri) => {
		const dir		= path.dirname(uri.path);
		const dirname	= workspace.path === dir ? '' : path.basename(dir);
		//should check against ignore list
		make_thumbnail(uri, vscode.Uri.joinPath(themeDir, dirname), dirname, path.basename(uri.fsPath)).then(success => {
			if (success) {
				if (timeout)
					clearTimeout(timeout);
				timeout = setTimeout(write_theme, 100);
			}
		});
	};

	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	watcher.onDidCreate(update);
	watcher.onDidChange(update);

	statusBarItem.hide();
	return watcher;
}

//-----------------------------------------------------------------------------
//	main entry
//-----------------------------------------------------------------------------
//options:
//use gitignore
//use another
//explicit list
//formats

//commands:
//clear cache

function getIconTheme(id: string) {
	for (const extension of vscode.extensions.all) {
		const themes = extension.packageJSON.contributes?.iconThemes;
		if (themes) {
			for (const theme of themes) {
				if (theme.id === id)
					return vscode.Uri.joinPath(extension.extensionUri, theme.path);
			}
		}
	}
}

async function copyIconTheme(destFile: vscode.Uri, sourceFile: vscode.Uri) {
	await vscode.workspace.fs.writeFile(destFile, Buffer.from(''));

	const sourceDir	= sourceFile.with({path: path.dirname(sourceFile.path)});
	const destDir	= destFile.with({path: path.dirname(destFile.path)});

	function copy(name: string) {
		return vscode.workspace.fs.copy(
			vscode.Uri.joinPath(sourceDir, name),
			vscode.Uri.joinPath(destDir, name),
			{ overwrite: true }
		);
	}

	const theme	= await vscode.workspace.fs.readFile(sourceFile).then(
		buffer => JSON.parse(buffer.toString()),
		() => ({})
	);

	for (const key in theme) {
		switch (key) {
			case 'iconDefinitions':
				for (const icon of Object.values(theme[key]) as any[]) {
					if (icon.iconPath)
						await copy(icon.iconPath);
				}
				break;

			case 'fonts':
				for (const font of theme[key]) {
					for (const src of font.src) {
						if (src.path)
							await copy(src.path);
					}
				}
				break;
		}
	}

	await vscode.workspace.fs.writeFile(destFile, Buffer.from(JSON.stringify(theme, null, 2)));
}

function exists(uri: vscode.Uri) {
	return vscode.workspace.fs.stat(uri).then(()=>true, ()=>false);
}

//-----------------------------------------------------------------------------
//	WASM
//-----------------------------------------------------------------------------
/*
// Define the interface for your WebAssembly module
interface DecoderModule {
    decode_bmp: (buffer: Uint8Array) => {
        width: number;
        height: number;
        data: Uint8Array;
    };
    free_image_data: (data: Uint8Array) => void;
}

let wasmModule: DecoderModule | null = null;

async function loadWasm(context: vscode.ExtensionContext) {
    const wasmPath = path.join(context.extensionPath, 'decoder.wasm');
    const wasmBuffer = fs.readFileSync(wasmPath);
    
    wasmModule = await instantiate<DecoderModule>(wasmBuffer, {});
}

export function wasm(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('myExtension.analyzeImage', async () => {
            if (!wasmModule) {
                await loadWasm(context);
            }

            if (!wasmModule) {
                vscode.window.showErrorMessage('Failed to load WebAssembly module');
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor || !editor.document.fileName.endsWith('.bmp')) {
                vscode.window.showErrorMessage('Not a BMP file!');
                return;
            }

            const imageBuffer = fs.readFileSync(editor.document.fileName);

            // Call the WebAssembly function
            const result = wasmModule.decode_bmp(new Uint8Array(imageBuffer));

            // Calculate average color
            let totalR = 0, totalG = 0, totalB = 0;
            for (let i = 0; i < result.data.length; i += 3) {
                totalR += result.data[i];
                totalG += result.data[i + 1];
                totalB += result.data[i + 2];
            }
            const pixelCount = result.width * result.height;
            const avgR = Math.round(totalR / pixelCount);
            const avgG = Math.round(totalG / pixelCount);
            const avgB = Math.round(totalB / pixelCount);

            vscode.window.showInformationMessage(
                `Image size: ${result.width}x${result.height}\n` +
                `Average color: rgb(${avgR},${avgG},${avgB})`
            );

            // Free the allocated memory
            wasmModule.free_image_data(result.data);
        })
    );
}
*/
//-----------------------------------------------------------------------------
//	main entry
//-----------------------------------------------------------------------------
//options:
//use gitignore
//use another
//explicit list
//formats

async function safeDeleteDir(dir: vscode.Uri, temp: vscode.Uri) {
	try {
		await vscode.workspace.fs.rename(dir, temp);
		await vscode.workspace.fs.delete(temp, { recursive: true });
	} catch (error) {
		console.error('Failed to delete directory:', error);
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const workspace		= vscode.workspace.workspaceFolders![0].uri;
	const localName		= workspace.fsPath.replace(/(:\\)|[\\/]/g, '-') + '.json';
	const themeDir		= vscode.Uri.joinPath(context.extensionUri, 'icons');
	const tempDir		= vscode.Uri.joinPath(context.extensionUri, 'temp');
	const localFile		= vscode.Uri.joinPath(themeDir, localName);
	const fallbackFile	= vscode.Uri.joinPath(themeDir, 'fallback.json');

	const config		= vscode.workspace.getConfiguration("thumbnails");
	const gitignore		= config.get<boolean>("useGitignore");

	let theme			= vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
	let fallback		= context.globalState.get<string>('thumbnails.fallback');

	async function makeIcons(always: boolean) {
		if (always || !await exists(themeDir)) {
			await vscode.workspace.fs.createDirectory(themeDir);
			const fallbackTheme = fallback && getIconTheme(fallback);
			if (fallbackTheme)
				await copyIconTheme(fallbackFile, fallbackTheme);
		}
		return await updateIconTheme(localFile, always);
	}

	let watcher = theme === "thumbnails" ? await makeIcons(false) : undefined;

	// Listen for configuration changes
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
		if (event.affectsConfiguration("workbench.iconTheme")) {
			if (watcher) {
				watcher.dispose();
				watcher = undefined;
				await safeDeleteDir(themeDir, tempDir);
			}
			const newtheme	= vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
			if (newtheme === "thumbnails") {
				if (theme !== "thumbnails")
					await context.globalState.update('thumbnails.fallback', fallback = theme);

				watcher = await makeIcons(true);
			}
			theme = newtheme;
		}
	}));

	//commands

	//refresh cache
	context.subscriptions.push(vscode.commands.registerCommand('thumbnails.refresh', async () => {
		if (watcher) {
			watcher.dispose();
			watcher = undefined;
		}
		await safeDeleteDir(themeDir, tempDir);
		if (theme === "thumbnails")
			makeIcons(true);
	}));
}

/*
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

async function safeDeleteDirectory(dirPath: string) {
    // Create a unique temp directory name
    const tempdir = path.join(os.tmpdir(), `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    
    try {
        // Attempt to rename - this will fail if directory is in use
        await fs.rename(dirPath, tempdir);
        
        // If rename succeeded, delete the temp directory
        await fs.rm(tempdir, { recursive: true, force: true });
    } catch (error) {
        if (error.code === 'EBUSY' || error.code === 'EPERM') {
            // Directory is in use or permission denied
            return false;
        }
        // Re-throw unexpected errors
        throw error;
    }
    return true;
}

// Usage:
try {
    const deleted = await safeDeleteDirectory(themeDir.fsPath);
    if (!deleted) {
        console.log('Directory is in use by another process');
    }
} catch (error) {
    console.error('Failed to delete directory:', error);
}

async function retryDelete(dirPath: string, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            const tempdir = path.join(os.tmpdir(), `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            await fs.rename(dirPath, tempdir);
            await fs.rm(tempdir, { recursive: true, force: true });
            return true;
        } catch (error) {
            if (i === attempts - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
        }
    }
    return false;
}

*/