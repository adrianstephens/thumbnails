import * as vscode from 'vscode';
import {promises as fs} from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import * as utils from './modules/utils';

interface ThemeIcon {
	iconPath: string;
}

interface IconTheme {
	iconDefinitions:	Record<string, ThemeIcon>;
	fileNames:			Record<string, string>;
	processedWorkspaces:Record<string, number>;
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
		await sharp(file.fsPath).resize(16, 16).toFile(out);
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
		utils.array_add(this.patterns, ignore.split(/\r?\n/).map(pattern => toRegExp(pattern)).filter(Boolean));
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

async function updateIconTheme(iconDir: vscode.Uri) {
	const themeFile = vscode.Uri.joinPath(iconDir, 'thumbnails.json');

	const theme: IconTheme = await vscode.workspace.fs.readFile(themeFile).then(
		buffer => JSON.parse(buffer.toString()),
		() => ({
			iconDefinitions:	{},
			fileNames:			{}
		})
	);

	const workspace		= vscode.workspace.workspaceFolders![0].uri;
	const themeTime 	= theme.processedWorkspaces?.[workspace.fsPath] ?? 0;

	const make_thumbnail = async (file: vscode.Uri, dest: vscode.Uri, dirname: string, name: string) => {
		for (let dot = -1; (dot = name.indexOf('.', dot + 1)) >= 0;) {
			const handler = handlers[name.slice(dot + 1)];
			if (handler) {
				const filename	= with_dir(dirname, name);
				const oldid		= theme.fileNames[filename];
				if (oldid) {
					const t0 = await time_stamp(vscode.Uri.joinPath(iconDir, theme.iconDefinitions[oldid].iconPath));
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

		const iconDir2 = vscode.Uri.joinPath(iconDir, dirname);
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

	const write_theme = () => {
		(theme.processedWorkspaces ??= {})[workspace.fsPath] = Date.now();
		return vscode.workspace.fs.writeFile(themeFile, Buffer.from(JSON.stringify(theme, null, 2)));
	};


	if (await time_stamp(workspace) > themeTime) {
		await scan(workspace, '', new Ignores('.git'));
		await write_theme();
	}

	let timeout: ReturnType<typeof setTimeout> | null = null;

	const update = (uri: vscode.Uri) => {
		const dir		= path.dirname(uri.path);
		const dirname	= workspace.path === dir ? '' : path.basename(dir);
		//should check against ignore list
		make_thumbnail(uri, vscode.Uri.joinPath(iconDir, dirname), dirname, path.basename(uri.fsPath)).then(success => {
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

function getExtensionForIconTheme(id: string) {
	for (const extension of vscode.extensions.all) {
		const themes = extension.packageJSON.contributes?.iconThemes;
		if (themes) {
			for (const theme of themes) {
				if (theme.id === id)
					return extension;
			}
		}
	}
}

function getIconTheme(extension: vscode.Extension<any>, id: string) {
	for (const theme of extension.packageJSON.contributes!.iconThemes) {
		if (theme.id === id)
			return theme;
	}
}

async function fallbackTheme(iconDir: vscode.Uri, id: string) {
	const extension = getExtensionForIconTheme(id);
	if (extension) {
		const theme = getIconTheme(extension, id);

		const sourceFile	= vscode.Uri.joinPath(extension.extensionUri, theme.path);
		const sourcePath	= vscode.Uri.joinPath(extension.extensionUri, path.dirname(theme.path));
		const destFile		= vscode.Uri.joinPath(iconDir, 'thumbnails.json');

		const sourceTheme	= await vscode.workspace.fs.readFile(sourceFile).then(
			buffer => JSON.parse(buffer.toString()),
			() => ({})
		);
		const destTheme		= await vscode.workspace.fs.readFile(destFile).then(
			buffer => JSON.parse(buffer.toString()),
			() => ({})
		);
	
		for (const key in sourceTheme) {
			destTheme[key] = sourceTheme[key];
			switch (key) {
				case 'iconDefinitions':
					for (const icon of Object.values(sourceTheme[key]) as any[]) {
						if (icon.iconPath) {
							const src	= vscode.Uri.joinPath(sourcePath, icon.iconPath);
							const dest	= vscode.Uri.joinPath(iconDir, icon.iconPath);
							await vscode.workspace.fs.copy(src, dest, { overwrite: true });
						}
					}
					break;

				case 'fonts':
					for (const font of sourceTheme[key]) {
						for (const src of font.src) {
							if (src.path)
								await vscode.workspace.fs.copy(vscode.Uri.joinPath(sourcePath, src.path), vscode.Uri.joinPath(iconDir, src.path), { overwrite: true });
						}
					}
					break;
			}
		}

		delete destTheme.processedWorkspaces;
		await vscode.workspace.fs.writeFile(destFile, Buffer.from(JSON.stringify(destTheme, null, 2)));
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const iconDir	= vscode.Uri.joinPath(context.extensionUri, 'icons');

	let theme		= vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
	let watcher		= theme === "thumbnails"
		? await vscode.workspace.fs.createDirectory(iconDir).then(() => updateIconTheme(iconDir))
		: undefined;

	// Listen for configuration changes
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
		if (event.affectsConfiguration("workbench.iconTheme")) {
			if (watcher) {
				watcher.dispose();
				watcher = undefined;
				const tempdir = iconDir.fsPath + '~';
				await fs.rename(iconDir.fsPath, tempdir);
				fs.rm(tempdir, { recursive: true, force: true });
			}
			const newtheme	= vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
			if (newtheme === "thumbnails") {
				await vscode.workspace.fs.createDirectory(iconDir);
				if (theme && theme !== "thumbnails")
					await fallbackTheme(iconDir, theme);
				watcher = await updateIconTheme(iconDir);
			}
			theme = newtheme;
		}
	}));
}
