#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';

// Cache processed files and tsconfig.json content
const processedFiles = new Set<string>();
let tsConfigCache: any = null;
let verboseMode = false;
let compressionEnabled = false;

// Entry point of the script
(async () => {
	try {
		// Get command-line arguments
		const args = process.argv.slice(2);

		if (args.includes('-v') || args.includes('--verbose')) {
			verboseMode = true;
		}

		if (args.includes('--compress')) {
			compressionEnabled = true;
		}

		// Handle help and version flags
		if (args.includes('-h') || args.includes('--help')) {
			displayHelp();
			return;
		}

		if (args.includes('--version')) {
			console.log('Script version 1.1.0');
			return;
		}

		// Parse output and input files
		const outputFlagIndex = args.findIndex(arg => arg === '-o' || arg === '--output');
		if (outputFlagIndex === -1 || outputFlagIndex === args.length - 1) {
			throw new Error('Missing output file. Use -o or --output followed by the output file path.');
		}
		const outputFile = args[outputFlagIndex + 1];
		const inputFiles = args.slice(0, outputFlagIndex);

		if (inputFiles.length === 0) {
			throw new Error('No input files specified.');
		}

		// Get project folder (defaults to current working directory)
		let projectFolder = process.cwd();
		const projectFlagIndex = args.findIndex(arg => arg === '-p' || arg === '--project');
		if (projectFlagIndex !== -1 && projectFlagIndex < args.length - 1) {
			projectFolder = path.resolve(args[projectFlagIndex + 1]);
		}

		// Read tsconfig.json once
		const tsConfig = await readTsConfig(projectFolder);

		// Clear the output file and process all input files
		await fs.writeFile(outputFile, '');
		await Promise.all(inputFiles.map(inputFile =>
			processFile(path.resolve(inputFile), outputFile, tsConfig, projectFolder)
		));

		// If compression is enabled, compress the output file
		if (compressionEnabled) {
			await compressOutput(outputFile);
			console.log(`Context successfully generated and compressed in ${outputFile}`);
		} else {
			console.log(`Context successfully generated in ${outputFile}`);
		}

	} catch (error: any) {
		console.error(`Error: ${error.message}`);
		process.exit(1);
	}
})();

/**
 * Reads tsconfig.json from the project folder, caches it for reuse.
 * @param projectFolder The root folder of the project
 * @returns Parsed tsconfig.json content
 */
async function readTsConfig(projectFolder: string): Promise<any> {
	if (tsConfigCache) return tsConfigCache;

	const tsConfigPath = path.join(projectFolder, 'tsconfig.json');
	try {
		const tsConfigContent = await fs.readFile(tsConfigPath, 'utf-8');
		tsConfigCache = JSON.parse(tsConfigContent);
		return tsConfigCache;
	} catch (err) {
		logVerbose(`Warning: Could not read tsconfig.json at ${tsConfigPath}. Default settings will be used.`);
		return {};
	}
}

/**
 * Recursively processes a file:
 * - Skips previously processed files.
 * - Minifies and appends file content to the output with markers.
 * - Recursively processes imported files.
 */
async function processFile(filePath: string, outputFile: string, tsConfig: any, projectFolder: string) {
	filePath = path.normalize(filePath);

	if (processedFiles.has(filePath)) return;
	processedFiles.add(filePath);

	if (filePath.includes(`node_modules${path.sep}`)) return;

	let content: string;
	try {
		content = await fs.readFile(filePath, 'utf-8');
		logVerbose(`Processing: ${filePath}`);
	} catch (err) {
		console.error(`Error reading file: ${filePath}`);
		return;
	}

	// Minify content (remove comments and extra whitespace)
	const minifiedContent = minifyContent(content);

	// Append file content with markers to the output file
	const fileHeader = `// Begin ${path.relative(projectFolder, filePath)}\n`;
	const fileFooter = `\n// End ${path.relative(projectFolder, filePath)}\n`;
	await fs.appendFile(outputFile, fileHeader + minifiedContent + fileFooter);

	// Recursively process imported files
	const importPaths = findImports(minifiedContent);
	await Promise.all(importPaths.map(async importPath => {
		const resolvedPath = await resolveImportPath(filePath, importPath, tsConfig, projectFolder);
		if (resolvedPath) {
			await processFile(resolvedPath, outputFile, tsConfig, projectFolder);
		}
	}));
}

/**
 * Minifies content by removing comments and unnecessary whitespaces.
 * @param content The original content of the file
 * @returns Minified content
 */
function minifyContent(content: string): string {
	// Remove comments (both single-line and multi-line)
	const withoutComments = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

	// Remove extra spaces and newlines
	return withoutComments.replace(/\s+/g, ' ').trim();
}

/**
 * Compresses the output file using Gzip compression.
 * @param outputFile The path of the output file to compress
 */
async function compressOutput(outputFile: string) {
	const outputContent = await fs.readFile(outputFile, 'utf-8');
	const compressedBuffer = zlib.gzipSync(outputContent);
	await fs.writeFile(outputFile, compressedBuffer);
}


/**
 * Finds import paths in the file content using regex.
 * Supports ES6, dynamic, CommonJS, and re-exports.
 */
function findImports(content: string): string[] {
	const importPaths: string[] = [];
	const patterns = [
		/import\s+.*?\s+from\s+['"](.*?)['"]/g,
		/import\(['"](.*?)['"]\)/g,
		/require\(['"](.*?)['"]\)/g,
		/export\s+.*?\s+from\s+['"](.*?)['"]/g,
	];

	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(content)) !== null) {
			importPaths.push(match[1]);
		}
	}

	return importPaths;
}

/**
 * Resolves the import path using tsconfig paths and baseUrl.
 */
async function resolveImportPath(currentFile: string, importPath: string, tsConfig: any, projectFolder: string): Promise<string | null> {
	const compilerOptions = tsConfig?.compilerOptions || {};
	const baseUrl = compilerOptions.baseUrl ? path.resolve(projectFolder, compilerOptions.baseUrl) : projectFolder;
	const paths = compilerOptions.paths || {};

	if (importPath.startsWith('.')) {
		const resolvedPath = path.resolve(path.dirname(currentFile), importPath);
		return findFileWithExtensions(resolvedPath);
	} else {
		return resolveModulePathUsingTsconfig(importPath, baseUrl, paths);
	}
}

async function resolveModulePathUsingTsconfig(moduleName: string, baseUrl: string, paths: { [key: string]: string[] }): Promise<string | null> {
	for (const [key, value] of Object.entries(paths)) {
		const keyPattern = key.replace(/\*/, '(.*)');
		const regex = new RegExp(`^${keyPattern}$`);
		const match = moduleName.match(regex);
		if (match) {
			for (const mappedPath of value) {
				const potentialPath = path.join(baseUrl, mappedPath.replace(/\*/, match[1]));
				const filePath = await findFileWithExtensions(potentialPath);
				if (filePath) return filePath;
			}
		}
	}
	return null;
}

/**
 * Tries to find a file by appending extensions or searching for index files.
 */
async function findFileWithExtensions(filePath: string): Promise<string | null> {
	const extensions = ['.ts', '.tsx', '.js', '.jsx'];

	try {
		const stats = await fs.stat(filePath);
		if (stats.isFile()) return filePath;

		if (stats.isDirectory()) {
			for (const ext of extensions) {
				const indexPath = path.join(filePath, 'index' + ext);
				try {
					await fs.access(indexPath);
					return indexPath;
				} catch { }
			}
		}
	} catch {
		for (const ext of extensions) {
			const fullPath = filePath + ext;
			try {
				await fs.access(fullPath);
				return fullPath;
			} catch { }
		}
	}
	return null;
}

/**
 * Displays a help message.
 */
function displayHelp() {
	console.log(`
Usage: script [input files] -o output_file [-p project_folder] [options]

Options:
  -o, --output       Specify the output file.
  -p, --project      Specify the project folder (defaults to current working directory).
  -v, --verbose      Enable verbose mode.
  -h, --help         Display this help message.
      --version      Display version information.
  `);
}

/**
 * Logs verbose messages if verbose mode is enabled.
 */
function logVerbose(message: string) {
	if (verboseMode) {
		console.log(`[Verbose] ${message}`);
	}
}
