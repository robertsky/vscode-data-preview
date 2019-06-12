'use strict';
import { 
  window,
  workspace, 
  Disposable, 
  Uri, 
  ViewColumn, 
  WorkspaceFolder, 
  Webview,
  WebviewPanel, 
  WebviewPanelOnDidChangeViewStateEvent, 
  WebviewPanelSerializer
} from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as avro from 'avsc';
import * as snappy from 'snappy';
import * as xlsx from 'xlsx';
import {Table} from 'apache-arrow';
//import * as parquet from 'parquetjs';
import * as config from './config';
import {Logger, LogLevel} from './logger';
import {previewManager} from './preview.manager';
import {Template} from './template.manager';

/**
 * Data preview web panel serializer for restoring previews on vscode reload.
 */
export class DataPreviewSerializer implements WebviewPanelSerializer {

  private _logger: Logger;
  
  /**
   * Creates new webview serializer.
   * @param viewType Web view type.
   * @param extensionPath Extension path for loading scripts, examples and data.
   * @param htmlTemplate Webview preview html template.
   */
  constructor(private viewType: string, private extensionPath: string, private htmlTemplate: Template) {
    this._logger = new Logger(`${this.viewType}.serializer:`, config.logLevel);
  }

  /**
   * Restores webview panel on vscode reload for data previews.
   * @param webviewPanel Webview panel to restore.
   * @param state Saved web view panel state.
   */
  async deserializeWebviewPanel(webviewPanel: WebviewPanel, state: any) {
    this._logger.debug('deserializeWeviewPanel(): uri:', state.uri.toString());
    this._logger.debug('deserializeWeviewPanel(): config:', state.config);
    previewManager.add(
      new DataPreview(
        this.viewType,
        this.extensionPath, 
        Uri.parse(state.uri),
        state.config, // view config
        webviewPanel.viewColumn, 
        this.htmlTemplate,
        webviewPanel
    ));
  }
}

/**
 * Main data preview webview implementation for this vscode extension.
 */
export class DataPreview {
    
  protected _disposables: Disposable[] = [];
  private _extensionPath: string;
  private _uri: Uri;
  private _previewUri: Uri;
  private _fileName: string;
  private _fileExtension: string;
  private _title: string;
  private _html: string;
  private _schema: any;
  private _panel: WebviewPanel;
  private _logger: Logger;
  private _config: any = {};
  private _tableList: Array<string> = [];
  private _dataTable: string = '';

  /**
   * Creates new data preview.
   * @param viewType Preview webview type, i.e. data.preview.
   * @param extensionPath Extension path for loading webview scripts, etc.
   * @param uri Source data file uri to preview.
   * @param viewConfig Data view config.
   * @param viewColumn vscode IDE view column to display data preview in.
   * @param htmlTemplate Webview html template reference.
   * @param panel Optional webview panel reference for restore on vscode IDE reload.
   */
  constructor(
    viewType: string,
    extensionPath: string, 
    uri: Uri,
    viewConfig: any, 
    viewColumn: ViewColumn, 
    htmlTemplate: Template, 
    panel?: WebviewPanel) {

    // save ext path, document uri, view config, and create preview uri
    this._extensionPath = extensionPath;
    this._uri = uri;
    this._config = viewConfig;
    this._fileName = path.basename(uri.fsPath);
    this._fileExtension = this._fileName.substr(this._fileName.lastIndexOf('.'));
    this._previewUri = this._uri.with({scheme: 'data'});
    this._logger = new Logger(`${viewType}:`, config.logLevel);

    // create preview panel title
    switch (viewType) {
      case 'data.preview':
        this._title = `${this._fileName} 🈸`;
        break;
      default: // TODO: add data.preview.help
        this._title = 'Data Preview 🈸 Help';
        break;
    }

    // create html template for data preview with local scripts, styles and theme params replaced
    const scriptsPath: string = Uri.file(path.join(this._extensionPath, 'scripts'))
      .with({scheme: 'vscode-resource'}).toString(true);
    const stylesPath: string = Uri.file(path.join(this._extensionPath, 'styles'))
      .with({scheme: 'vscode-resource'}).toString(true);
    this._html = htmlTemplate.replace({
      scripts: scriptsPath,
      styles: stylesPath,
      theme: this.theme,
      charts: this.charts
    });

    // initialize webview panel
    this._panel = panel;
    this.initWebview(viewType, viewColumn);
    this.configure();
  } // end of constructor()

  /**
   * Initializes data preview webview panel.
   * @param viewType Preview webview type, i.e. data.preview.
   * @param viewColumn vscode IDE view column to display preview in.
   */
  private initWebview(viewType: string, viewColumn: ViewColumn): void {
    if (!this._panel) {
      // create new webview panel
      this._panel = window.createWebviewPanel(viewType, this._title, viewColumn, this.getWebviewOptions());
    }

    // dispose preview panel handler
    this._panel.onDidDispose(() => {
      this.dispose();
    }, null, this._disposables);

    // TODO: handle view state changes later
    this._panel.onDidChangeViewState(
      (viewStateEvent: WebviewPanelOnDidChangeViewStateEvent) => {
      let active = viewStateEvent.webviewPanel.visible;
    }, null, this._disposables);

    // process web view messages
    this.webview.onDidReceiveMessage(message => {
      switch (message.command) {
        case 'refresh':
          // reload file data for preview
          this.refresh(message.table);
          break;
        case 'config':
          // save data viewer config for restore on vscode reload
          this._config = message.config;
          if (config.logLevel === LogLevel.Debug) {
            this._logger.debug('configUpdate(): config:', message.config);
          }
          break;
        case 'saveData':
          // saves data view config, or filtered json or csv data
          this.saveData(message.fileType, message.data);
          break;
        case 'loadConfig':
          // prompts to load saved data view config
          this.loadConfig();
          break;
        case 'undoConfig':
          // TODO: implement view config undo
          break;
        case 'undoConfig':
          // TODO: implement view config redo
          break;    
      }
    }, null, this._disposables);
  } // end of initWebview()

  /**
   * Creates webview options with local resource roots, etc
   * for data preview webview display.
   */
  private getWebviewOptions(): any {
    return {
      enableScripts: true,
      enableCommandUris: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.getLocalResourceRoots()
    };
  }

  /**
   * Creates local resource roots for loading assets in data preview webview.
   */
  private getLocalResourceRoots(): Uri[] {
    const localResourceRoots: Uri[] = [];
    const workspaceFolder: WorkspaceFolder = workspace.getWorkspaceFolder(this.uri);
    if (workspaceFolder) {
      localResourceRoots.push(workspaceFolder.uri);
    }
    else if (!this.uri.scheme || this.uri.scheme === 'file') {
      localResourceRoots.push(Uri.file(path.dirname(this.uri.fsPath)));
    }
    
    // add data preview js scripts
    localResourceRoots.push(Uri.file(path.join(this._extensionPath, 'scripts')));

    // add data preview styles
    localResourceRoots.push(Uri.file(path.join(this._extensionPath, 'styles')));

    this._logger.logMessage(LogLevel.Debug, 'getLocalResourceRoots():', localResourceRoots);
    return localResourceRoots;
  }

  /**
   * Configures webview html for preview.
   */
  public configure(): void {
    this.webview.html = this.html;
    // NOTE: let webview fire refresh message
    // when data preview DOM content is initialized
    // see: data.view.html/this.refresh();
  }

  /**
   * Reloads data preview on data file save changes or vscode IDE reload.
   * @param dataTable Optional data table name for files with multiple data sets.
   */
  public refresh(dataTable = ''): void {
    // reveal corresponding data preview panel
    this._panel.reveal(this._panel.viewColumn, true); // preserve focus

    if (dataTable.length >  0) {
      // save requested data table
      this._dataTable = dataTable;
    }

    // read and send updated data to webview
    // workspace.openTextDocument(this.uri).then(document => {
      this._logger.debug(`refresh(${this._dataTable}): file:`, this._fileName);
      //const textData: string = document.getText();
      let data = [];
      try {
        // get file data
        data = this.getFileData(this._fileName);
      }
      catch (error) {
        this._logger.logMessage(LogLevel.Error, `refresh(${this._dataTable}):`, error.message);
        this.webview.postMessage({error: error});
      }
      this.loadData(data);
    // });
  }

  /**
   * Loads string or JSON data into data view.
   */
  private loadData(data: any): void {
    if (data === undefined || data.length <= 0) {
      // no valid data to load
      return;
    }    
    try {
        // update web view
        this.webview.postMessage({
          command: 'refresh',
          fileName: this._fileName,
          uri: this._uri.toString(),
          config: this.config,
          schema: this.schema,
          tableList: this._tableList,
          table: this._dataTable,
          data: data
        });
    }
    catch (error) {
      this._logger.logMessage(LogLevel.Error, 'loadData():', error.message);
      this.webview.postMessage({error: error});
    }
  }

  /**
   * Prompts to load saved data view config.
   */
   private async loadConfig(): Promise<void> {
    let configFilePath: string = this._uri.fsPath.replace(this._fileExtension, '');
    this._logger.debug('loadConfig(): loading config:', configFilePath);

    // display open config files dialog
    const configFiles: Uri[] = await window.showOpenDialog({
      canSelectMany: false,
      defaultUri: Uri.parse(configFilePath).with({scheme: 'file'}),
      filters: {'Config': ['config']}
    });

    if (configFiles.length > 0) {
      // get the first selected config file
      configFilePath = configFiles[0].fsPath;
      this._logger.debug('loadConfig(): loading config:', configFilePath);

      // load view config
      const configString: string = fs.readFileSync(configFilePath, 'utf8'); // file encoding to read data as string
      const viewConfig: any = JSON.parse(configString);

      if (this._uri.fsPath.indexOf(viewConfig.dataFileName) >=0) { // matching data file config
        // save loaded view config, and data table reference if present
        this._config = viewConfig.config;
        this._dataTable = (viewConfig.dataTable === undefined) ? '': viewConfig.dataTable;
        this._logger.debug('loadConfig(): loaded view config:', this._config);
        this.refresh(this._dataTable); // reload data & config for display
      }
      else {
        window.showErrorMessage(`Config data file '${viewConfig.dataFileName}' doesn't match '${this._fileName}'!`);
      }
    }
  } // end of loadConfig()

  /**
   * Loads actual local data file content.
   * @param filePath Local data file path.
   * @returns CSV/JSON string or Array of row objects.
   * TODO: change this to async later
   */
  private getFileData(filePath: string): any {
    let data: any = null;
    const dataFilePath = path.join(path.dirname(this._uri.fsPath), filePath);
    if (!fs.existsSync(dataFilePath)) {
      this._logger.logMessage(LogLevel.Error, 'getFileData():', `${filePath} doesn't exist!`);
      window.showErrorMessage(`${filePath} doesn't exist!`);
      return data;
    }

    // read file data
    // TODO: rework this to using fs.ReadStream for large data files support later
    switch (this._fileExtension) {
      case '.csv':
      case '.tsv':
      case '.txt':
      case '.tab':
      case '.json':
        data = fs.readFileSync(dataFilePath, 'utf8'); // file encoding to read data as string
        break;
      case '.xls':
      case '.xlsb':
      case '.xlsx':
      case '.xlsm':
      case '.slk':
      case '.ods':
      case '.prn':
        data = this.getBinaryExcelData(dataFilePath);
        break;
      case '.dif':
      case '.xml':
      case '.html':
        data = this.getTextExcelData(dataFilePath);
        break;
      case '.arrow':
        data = this.getArrowData(dataFilePath);
        break;
      case '.avro':
        data = this.getAvroData(dataFilePath);
        break;
      case '.parquet':
        // TODO: sort out node-gyp lzo lib loading for parquet data files parse
        window.showInformationMessage('Parquet data format support coming soon!');        
        //data = this.getParquetData(dataFilePath);
        break;
    }
    return data;
  } // end of getFileData()

  /**
   * Gets binary Excel file data.
   * @param dataFilePath Excel file path.
   * @returns Array of row objects.
   */  
  private getBinaryExcelData(dataFilePath: string): any[] {
    // load Excel workbook
    const workbook: xlsx.WorkBook = xlsx.readFile(dataFilePath, {
      type: 'binary',
      cellDates: true,
    });
    return this.getExcelData(workbook);
  }

  /**
   * Gets text Excel file data.
   * @param dataFilePath Excel file path.
   * @returns Array of row objects.
   */  
  private getTextExcelData(dataFilePath: string): any[] {
    // load Excel workbook
    const workbook: xlsx.WorkBook = xlsx.readFile(dataFilePath, {
      type: 'file',
      cellDates: true,
    });
    return this.getExcelData(workbook);
  }

  /**
   * Gets Excel file data.
   * @param workbook Excel workbook.
   * @returns Array of row objects.
   */
  private getExcelData(workbook: xlsx.WorkBook): any[] {
    this._logger.debug(`getExcelData(): file: ${this._fileName} sheetNames:`, workbook.SheetNames);
    let dataRows: Array<any> = [];
    const dataSchema = null;
    if (workbook.SheetNames.length > 0) {
      if (workbook.SheetNames.length > 1) {
        // save sheet names for table list UI display
        this._tableList = workbook.SheetNames;
      }

      // determine spreadsheet to load
      let sheetName = workbook.SheetNames[0];
      if (this._dataTable.length > 0) {
        // reset to requested table name
        sheetName = this._dataTable;
      }
      
      // get worksheet data row objects array
      const worksheet: xlsx.Sheet = workbook.Sheets[sheetName];
      dataRows = xlsx.utils.sheet_to_json(worksheet);

      // create json data file for text data preview
      let jsonFilePath: string = this._uri.fsPath.replace(this._fileExtension, '.json');
      if (this._dataTable.length > 0 && this._tableList.length > 1) {
        // append sheet name to generated json data file
        jsonFilePath = jsonFilePath.replace('.json', `-${sheetName}.json`);
      }
      this.createJsonFile(jsonFilePath, dataRows);
      this.logDataStats(dataSchema, dataRows);
    }
    return dataRows;
  } // end of getExcelData()

  /**
   * Gets binary Arrow file data.
   * @param dataFilePath Arrow data file path.
   * @returns Array of row objects.
   */
  private getArrowData(dataFilePath: string): any[] {
    const dataBuffer = fs.readFileSync(dataFilePath);
    const dataTable: Table = Table.from(new Uint8Array(dataBuffer));
    const dataRows: Array<any> = Array(dataTable.length);
    const fields = dataTable.schema.fields.map(field => field.name);
    for (let i=0, n=dataRows.length; i<n; ++i) {
      const proto = {};
      fields.forEach((fieldName, index) => {
        const column = dataTable.getColumnAt(index);
        proto[fieldName] = column.get(i);
      });
      dataRows[i] = proto;
    }

    // remap arrow data schema to columns for data viewer
    this._schema = {};
    dataTable.schema.fields.map(field => {
      let fieldType: string = field.type.toString();
      const typesIndex: number = fieldType.indexOf('<');
      if (typesIndex > 0) {
        fieldType = fieldType.substring(0, typesIndex);
      }
      this._schema[field.name] = config.dataTypes[fieldType];
    });

    // initialized typed data set columns config
    // this._config['columns'] = dataTable.schema.fields.map(field => field.name);

    // create data json and schema.json for text arrow data preview
    this.createJsonFile(this._uri.fsPath.replace(this._fileExtension, '.json'), dataRows);
    this.createJsonFile(this._uri.fsPath.replace(this._fileExtension, '.schema.json'), dataTable.schema);
    this.logDataStats(dataTable.schema, dataRows);
    return dataRows;
  } // end of getArrowData()

  /**
   * Gets binary Avro file data.
   * @param dataFilePath Avro data file path.
   * @returns Array of row objects.
   */
  private getAvroData(dataFilePath: string): any[] {
    let dataSchema: any = {};
    let dataRows: Array<any> = [];
    const dataBlockDecoder: avro.streams.BlockDecoder = avro.createFileDecoder(dataFilePath);
    dataBlockDecoder.on('metadata', (type: any) => dataSchema = type);
		dataBlockDecoder.on('data', (data: any) => dataRows.push(data));
    dataBlockDecoder.on('end', () => {
      // create data json and schema.json files for text data preview
      this.createJsonFile(this._uri.fsPath.replace(this._fileExtension, '.json'), dataRows);
      this.createJsonFile(this._uri.fsPath.replace(this._fileExtension, '.schema.json'), dataSchema);
      this.logDataStats(dataSchema, dataRows);
      // update web view: flatten data rows for now since Avro format has hierarchical data structure
      dataRows = dataRows.map(rowObject => this.flattenObject(rowObject));
      this.loadData(dataRows);
    });
    return dataRows;
  }

  /**
   * Gets binary Parquet file data.
   * @param dataFilePath Parquet data file path.
   * @returns Array of row objects.
   */ /*
  private async getParquetData(dataFilePath: string) {
    let dataSchema: any = {};
    let dataRows: Array<any> = [];
    const parquetReader = await parquet.ParquetReader.openFile(dataFilePath);
    const cursor = parquetReader.getCursor();
    // read all records
    let record = null;
    while (record = await cursor.next()) {
      dataRows.push(record);
    }
    await parquetReader.close();
    dataRows = dataRows.map(rowObject => this.flattenObject(rowObject));    
    this.logDataStats(dataSchema, dataRows);
    // update web view
    this.loadData(dataRows);
    return dataRows;
  } */

  /**
   * Flattens objects with nested properties for data view display.
   * @param obj Object to flatten.
   * @returns Flat Object.
   */
  private flattenObject (obj: any): any {
    const flatObject: any = {};
    Object.keys(obj).forEach((key) => {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        Object.assign(flatObject, this.flattenObject(obj[key]));
      } else {
        flatObject[key] = obj[key];
      }
    });
    return flatObject;
  }

  /**
   * Logs data stats for debug.
   * @param dataSchema metadata.
   * @param dataRows data rows.
   */
  private logDataStats(dataSchema: any, dataRows: Array<any>): void {
    if (config.logLevel === LogLevel.Debug) {
      if (dataSchema !== null) {
        this._logger.debug(`logDataStats(): ${this._fileName} data schema:`, dataSchema);
        this._logger.debug('logDataStats(): data view schema:', this._schema);
      }
      this._logger.debug('logDataStats(): records count:', dataRows.length);
      if (dataRows.length > 0) {
        const firstRow = dataRows[0];
        this._logger.debug('logDataStats(): 1st row:', firstRow);
      }
    }
  }

  /**
   * Creates JSON data or schema.json file.
   * @param jsonFilePath Json file path.
   * @param jsonData Json file data.
   */
  private createJsonFile(jsonFilePath: string, jsonData: any): void {
    if (!fs.existsSync(jsonFilePath)) {
      const jsonString: string = JSON.stringify(jsonData, null, 2); 
      try {
        // TODO: rework this to async file write later
        const jsonFileWriteStream: fs.WriteStream = fs.createWriteStream(jsonFilePath, {encoding: 'utf8'});
        jsonFileWriteStream.write(jsonString);
        jsonFileWriteStream.end();
        this._logger.debug('createJsonFile(): saved:', jsonFilePath);
      } catch (error) {
        const errorMessage: string = `Failed to save file: ${jsonFilePath}`;
        this._logger.logMessage(LogLevel.Error, 'crateJsonFile():', errorMessage);
        window.showErrorMessage(errorMessage);
      }
    }
  }

  /**
   * Saves posted data from data view.
   * @param fileType Data file type.
   * @param fileData File data to save.
   */
  private async saveData(fileType: string, fileData: any): Promise<void> {
    let dataFilePath: string = this._uri.fsPath.replace(this._fileExtension, '');
    if (this._dataTable.length > 0) {
      // append data table name to new config or data export file name
      dataFilePath += `-${this._dataTable}`;
    }
    // add requested data file ext.
    dataFilePath += fileType;
    this._logger.debug('saveData(): saving data file:', dataFilePath);

    // display save file dialog
    const dataFileUri: Uri = await window.showSaveDialog({
      defaultUri: Uri.parse(dataFilePath).with({scheme: 'file'})
    });

    if (dataFileUri) {
      if (dataFilePath.endsWith('.config') || dataFilePath.endsWith('.json')) {
        fileData = JSON.stringify(fileData, null, 2);
      }  
      fs.writeFile(dataFileUri.fsPath, fileData, (error) => {
        if (error) {
          const errorMessage: string = `Failed to save file: ${dataFileUri.fsPath}`;
          this._logger.logMessage(LogLevel.Error, 'saveData():', errorMessage);
          window.showErrorMessage(errorMessage);
        }
      });
    }
  } // end of saveData()

  /**
   * Disposes this preview resources.
   */
  public dispose() {
    previewManager.remove(this);
    this._panel.dispose();
    while (this._disposables.length) {
      const item = this._disposables.pop();
      if (item) {
        item.dispose();
      }
    }
  }

  /**
   * Gets preview panel visibility status.
   */
  get visible(): boolean {
    return this._panel.visible;
  }

  /**
   * Gets the underlying webview instance for this preview.
   */
  get webview(): Webview {
    return this._panel.webview;
  }
    
  /**
   * Gets the source data doc uri for this preview.
   */
  get uri(): Uri {
    return this._uri;
  }

  /**
   * Gets the preview uri to load on data preview command triggers or vscode IDE reload. 
   */
  get previewUri(): Uri {
    return this._previewUri;
  }
  
  /**
   * Gets the html content to load for this preview.
   */
  get html(): string {
    return this._html;
  }

  /**
   * Gets data viewer config for data preview settings restore on vscode reload.
   */
  get config(): any {
    return this._config;
  }

  /**
   * Gets data schema for typed data sets.
   */
  get schema(): any {
    return this._schema;
  }

  /**
   * Gets UI theme to use for Data Preview display from workspace config.
   * see package.json 'configuration' section for more info.
   */
  get theme(): string {
    return <string>workspace.getConfiguration('data.preview').get('theme');
  }

  /**
   * Gets charts plugin preference for Data Preview display from workspace config.
   * see package.json 'configuration' section for more info.
   */
  get charts(): string {
    return <string>workspace.getConfiguration('data.preview').get('charts.plugin');
  }

  /**
   * Create JSON data & schema.json files config option for Arrow, Avro & Excel data files.
   */
  get createJsonFiles(): boolean {
    return <boolean>workspace.getConfiguration('data.preview').get('create.json.files');
  }
}
