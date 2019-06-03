import {
  window,
  EventEmitter,
  TextDocumentContentProvider,
  Uri
} from "vscode";
import * as fs from 'fs';
import * as avro from 'avsc';
import * as config from '../config';
import {Logger, LogLevel} from '../logger';

class JsonData {
  data: string = '';
}

export class AvroContentProvider implements TextDocumentContentProvider {
  // data change emitter
  onDidChangeEmitter = new EventEmitter<Uri>();
  onDidChange = this.onDidChangeEmitter.event;

  // json data map & logger
  private jsonFileDataMap: Map<string, JsonData> = new Map();
  private logger = new Logger(`avro.data.provider:`, config.logLevel);

  /**
   * Creates new Avro data content provider for viewing 
   * Avro data and schema as json in a text editor.
   * @param viewType avro.data.json || avro.data.schema.json
   */
  constructor(private viewType: string = 'avro.data.json') {
    this.logger.debug('(): created for:', viewType);
  }

  /**
   * Provides Avro data JSON content.
   * @param uri Avro data file uri.
   */
  async provideTextDocumentContent(uri: Uri): Promise<string> {
    this.logger.debug('provideTextDocumentContent(): uri:', uri);
    return new Promise<string>((resolve, reject) => {
      // create json data file path
      const jsonFilePath = uri.path.replace(RegExp('\.json$'), '');
      if (this.jsonFileDataMap.has(jsonFilePath)) {
        // load cached json data
        resolve(this.jsonFileDataMap.get(jsonFilePath)!.data);
      }
      // load Avro file data as JSON
      const dataFilePath: string = uri.toString();
      let dataRows: Array<any> = [];
      let dataSchema: any = {};
      const jsonData: JsonData = new JsonData();
      this.jsonFileDataMap.set(jsonFilePath, jsonData);
      const dataBlockDecoder: avro.streams.BlockDecoder = avro.createFileDecoder(dataFilePath);

      // process Avro data schema
      dataBlockDecoder.on('metadata', (type: any) => {
        dataSchema = type;
        jsonData.data = JSON.stringify(dataSchema, null, 2);
        this.onDidChangeEmitter.fire(uri);
        this.logger.debug('getAvroData(): data schema:', dataSchema);
        // save generated Avro data schema json
        const jsonFilePath:string = dataFilePath.replace('.avro', `.avro.schema.json`);
        fs.writeFile(jsonFilePath, jsonData.data, (error) => {
          if (error) {
            const errorMessage: string = `Failed to save file: ${jsonFilePath}`;
            this.logger.logMessage(LogLevel.Error, 'provideTextDocumentContent():', errorMessage);
            window.showErrorMessage(errorMessage);
          }
        });
        // post Avro schema json
        resolve(jsonData.data);
      });

      // process Avro data
      if (this.viewType === 'avro.data.json') {
        // read Avro data
        dataBlockDecoder.on('data', (data: any) => {
          dataRows.push(data);
          jsonData.data = JSON.stringify(dataRows, null, 2);
          this.onDidChangeEmitter.fire(uri);
        });
        dataBlockDecoder.on('end', () => {
          jsonData.data = JSON.stringify(dataRows, null, 2);
          // save generated Avro data json
          const jsonFilePath:string = dataFilePath.replace('.avro', `.avro.json`);
          fs.writeFile(jsonFilePath, jsonData.data, (error) => {
            if (error) {
              const errorMessage: string = `Failed to save file: ${jsonFilePath}`;
              this.logger.logMessage(LogLevel.Error, 'provideTextDocumentContent():', errorMessage);
              window.showErrorMessage(errorMessage);
            }
          });  
          // post Avro data json
          resolve(jsonData.data);
        });  
      }

      // TODO: add Avro data file load error handler
      // window.showErrorMessage(message);
      // reject(message);
    });
  }
}
