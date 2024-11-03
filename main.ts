import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { EditorPosition, TFile } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
	minWordLength: number;
	ignoredWords: string[];
	caseSensitive: boolean;
	scanOnLoad: boolean;
	linkPrefix: string;
	autoLinkEnabled: boolean;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	minWordLength: 3,
	ignoredWords: ['the', 'and', 'but', 'for'],
	caseSensitive: false,
	scanOnLoad: true,
	linkPrefix: '[[]]',
	autoLinkEnabled: true,
}

export default class AutoLinkPlugin extends Plugin {
	settings: MyPluginSettings;
	linkCache: Map<string, string> = new Map(); // Store known links
	changeHistory: Array<{text: string, position: EditorPosition, file: string}> = [];

	async onload() {
		await this.loadSettings();

		// Add ribbon icon for vault scan
		this.addRibbonIcon('links', 'Scan Vault for Links', async () => {
			await this.scanVaultForLinks();
		});

		// Add command to scan vault with hotkey
		this.addCommand({
			id: 'scan-vault-for-links',
			name: 'Scan Vault for Links',
			hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'l' }],
			callback: async () => {
				await this.scanVaultForLinks();
			}
		});

		// Add command to undo last auto-link with hotkey
		this.addCommand({
			id: 'undo-last-autolink',
			name: 'Undo Last Auto Link',
			hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'u' }],
			callback: () => this.undoLastLink()
		});

		// Add command to toggle auto-linking with hotkey
		this.addCommand({
			id: 'toggle-auto-linking',
			name: 'Toggle Auto Linking',
			hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 't' }],
			callback: () => {
				this.settings.autoLinkEnabled = !this.settings.autoLinkEnabled;
				this.saveSettings();
				new Notice(`Auto Linking ${this.settings.autoLinkEnabled ? 'Enabled' : 'Disabled'}`);
			}
		});

		// Register editor changes handler
		this.registerEvent(
			this.app.workspace.on('editor-change', async (editor: Editor) => {
				if (this.settings.autoLinkEnabled) {
					await this.handleEditorChange(editor);
				}
			})
		);

		// Register paste handler
		this.registerEvent(
			this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor) => {
				if (this.settings.autoLinkEnabled) {
					await this.handlePaste(evt, editor);
				}
			})
		);

		// If scanOnLoad is enabled, scan vault when plugin loads
		if (this.settings.scanOnLoad) {
			this.scanVaultForLinks();
		}
	}

	async scanVaultForLinks() {
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			const content = await this.app.vault.read(file);
			// Scan for potential link targets and add to linkCache
			this.updateLinkCache(content, file.path);
		}
		new Notice(`Scanned ${files.length} files for potential links`);
	}

	private async handleEditorChange(editor: Editor) {
		// Get the current line
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		
		// Check for potential links in the current line
		await this.processLineForLinks(editor, line, cursor.line);
	}

	private async handlePaste(evt: ClipboardEvent, editor: Editor) {
		// Process pasted content for potential links
		const pastedText = evt.clipboardData?.getData('text');
		if (pastedText) {
			// Process the pasted text for potential links
			await this.processTextForLinks(editor, pastedText);
		}
	}

	private async processLineForLinks(editor: Editor, line: string, lineNumber: number) {
		const words = line.split(/\s+/);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const currentFilePath = view.file?.path;
		if (!currentFilePath) return;

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			const cleanWord = word.replace(/^[.,/#!$%^&*;:{}=\-_`~()[\]]*|[.,/#!$%^&*;:{}=\-_`~()[\]]*$/g, '');
			const searchWord = this.settings.caseSensitive ? cleanWord : cleanWord.toLowerCase();

			if (cleanWord.length >= this.settings.minWordLength &&
				!this.settings.ignoredWords.includes(searchWord)) {
				
				const linkedFilePath = this.linkCache.get(searchWord);
				
				// Check if word exists in cache and isn't already a link
				if (linkedFilePath && 
					linkedFilePath !== currentFilePath && 
					!word.includes('[[') && 
					!word.includes(']]')) {
					
					// Find word position in line
					const lineUpToWord = line.substring(0, line.indexOf(word));
					const startPos = {
						line: lineNumber,
						ch: lineUpToWord.length
					};
					const endPos = {
						line: lineNumber,
						ch: lineUpToWord.length + word.length
					};

					// Create the link
					const linkedText = `[[${word}]]`;
					
					// Store change in history
					this.changeHistory.push({
						text: word,
						position: startPos,
						file: currentFilePath
					});

					// Replace text with link
					editor.replaceRange(linkedText, startPos, endPos);
					
					new Notice(`Linked "${word}" to ${linkedFilePath}`);
				}
			}
		}
	}

	private async processTextForLinks(editor: Editor, text: string) {
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const cursor = editor.getCursor();
			await this.processLineForLinks(editor, lines[i], cursor.line + i);
		}
	}

	private async undoLastLink() {
		const lastChange = this.changeHistory.pop();
		if (lastChange) {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;

			const editor = view.editor;
			const currentFile = view.file;

			if (currentFile && currentFile.path === lastChange.file) {
				const startPos = lastChange.position;
				const endPos = {
					line: startPos.line,
					ch: startPos.ch + lastChange.text.length + 4 // +4 for the [[ and ]] characters
				};

				editor.replaceRange(lastChange.text, startPos, endPos);
				new Notice('Undid last auto-link');
			}
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async updateLinkCache(content: string, filePath: string) {
		// Split content into words and filter for potential link targets
		const words = content.split(/\s+/);
		
		words.forEach(word => {
			// Clean the word of punctuation
			const cleanWord = word.replace(/^[.,/#!$%^&*;:{}=\-_`~()[\]]*|[.,/#!$%^&*;:{}=\-_`~()[\]]*$/g, '');
			
			// Check if word meets criteria
			if (cleanWord.length >= this.settings.minWordLength && 
				!this.settings.ignoredWords.includes(cleanWord.toLowerCase())) {
				
				// Store in cache with filepath
				this.linkCache.set(
					this.settings.caseSensitive ? cleanWord : cleanWord.toLowerCase(),
					filePath
				);
			}
		});
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class AutoLinkSettingTab extends PluginSettingTab {
	plugin: AutoLinkPlugin;

	constructor(app: App, plugin: AutoLinkPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Minimum Word Length')
			.setDesc('Minimum length of words to consider for auto-linking')
			.addText(text => text
				.setPlaceholder('3')
				.setValue(this.plugin.settings.minWordLength.toString())
				.onChange(async (value) => {
					this.plugin.settings.minWordLength = parseInt(value) || 3;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Case Sensitive')
			.setDesc('Should matching be case sensitive?')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.caseSensitive)
				.onChange(async (value) => {
					this.plugin.settings.caseSensitive = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Scan on Load')
			.setDesc('Automatically scan vault when plugin loads')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.scanOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.scanOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Ignored Words')
			.setDesc('Comma-separated list of words to ignore')
			.addText(text => text
				.setPlaceholder('the,and,but,for')
				.setValue(this.plugin.settings.ignoredWords.join(','))
				.onChange(async (value) => {
					this.plugin.settings.ignoredWords = value.split(',').map(word => word.trim());
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto Linking Enabled')
			.setDesc('Enable or disable automatic linking while typing')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoLinkEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autoLinkEnabled = value;
					await this.plugin.saveSettings();
				}));
	}
}
