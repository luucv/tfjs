/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {env} from '../environment';

import {getModelArtifactsInfoForJSON, concatenateArrayBuffers} from './io_utils';
import {ModelStoreManagerRegistry} from './model_management';
import {IORouter, IORouterRegistry} from './router_registry';
import {IOHandler, ModelArtifacts, IDBModelArtifacts, ModelArtifactsInfo, ModelStoreManager, SaveResult} from './types';

const DATABASE_NAME = 'tensorflowjs';
const DATABASE_VERSION = 1;

// Saving in chuncks allows to store bigger models.
const MAX_CHUNCK_SIZE = 15000000; // 15mb

// Model data and ModelArtifactsInfo (metadata) are stored in two separate
// stores for efficient access of the list of stored models and their metadata.
// 1. The object store for model data: topology, weights and weight manifests.
const MODEL_STORE_NAME = 'models_store';
// 2. The object store for ModelArtifactsInfo, including meta-information such
//    as the type of topology (JSON vs binary), byte size of the topology, byte
//    size of the weights, etc.
const INFO_STORE_NAME = 'model_info_store';
// 3. The object store for WeightData
const WEIGHTS_STORE_NAME = 'model_weights';

/**
 * Delete the entire database for tensorflow.js, including the models store.
 */
export async function deleteDatabase(): Promise<void> {
  const idbFactory = getIndexedDBFactory();

  return new Promise<void>((resolve, reject) => {
    const deleteRequest = idbFactory.deleteDatabase(DATABASE_NAME);
    deleteRequest.onsuccess = () => resolve();
    deleteRequest.onerror = error => reject(error);
  });
}

function getIndexedDBFactory(): IDBFactory {
  if (!env().getBool('IS_BROWSER')) {
    // TODO(cais): Add more info about what IOHandler subtypes are available.
    //   Maybe point to a doc page on the web and/or automatically determine
    //   the available IOHandlers and print them in the error message.
    throw new Error(
        'Failed to obtain IndexedDB factory because the current environment' +
        'is not a web browser.');
  }
  // tslint:disable-next-line:no-any
  const theWindow: any = window;
  const factory = theWindow.indexedDB || theWindow.mozIndexedDB ||
      theWindow.webkitIndexedDB || theWindow.msIndexedDB ||
      theWindow.shimIndexedDB;
  if (factory == null) {
    throw new Error(
        'The current browser does not appear to support IndexedDB.');
  }
  return factory;
}

function setUpDatabase(openRequest: IDBRequest) {
  const db = openRequest.result as IDBDatabase;
  db.createObjectStore(MODEL_STORE_NAME, {keyPath: 'modelPath'});
  db.createObjectStore(INFO_STORE_NAME, {keyPath: 'modelPath'});
  db.createObjectStore(WEIGHTS_STORE_NAME, {keyPath: 'chunckId'});
}

/**
 * IOHandler subclass: Browser IndexedDB.
 *
 * See the doc string of `browserIndexedDB` for more details.
 */
export class BrowserIndexedDB implements IOHandler {
  protected readonly indexedDB: IDBFactory;
  protected readonly modelPath: string;

  static readonly URL_SCHEME = 'indexeddb://';

  constructor(modelPath: string) {
    this.indexedDB = getIndexedDBFactory();

    if (modelPath == null || !modelPath) {
      throw new Error(
          'For IndexedDB, modelPath must not be null, undefined or empty.');
    }
    this.modelPath = modelPath;
  }

  async save(modelArtifacts: ModelArtifacts): Promise<SaveResult> {
    // TODO(cais): Support saving GraphDef models.
    if (modelArtifacts.modelTopology instanceof ArrayBuffer) {
      throw new Error(
          'BrowserLocalStorage.save() does not support saving model topology ' +
          'in binary formats yet.');
    }

    return this.databaseAction(this.modelPath, modelArtifacts) as
        Promise<SaveResult>;
  }

  async load(): Promise<ModelArtifacts> {
    return this.databaseAction(this.modelPath) as Promise<ModelArtifacts>;
  }

  /**
   * Perform database action to put model artifacts into or read model artifacts
   * from IndexedDB object store.
   *
   * Whether the action is put or get depends on whether `modelArtifacts` is
   * specified. If it is specified, the action will be put; otherwise the action
   * will be get.
   *
   * @param modelPath A unique string path for the model.
   * @param modelArtifacts If specified, it will be the model artifacts to be
   *   stored in IndexedDB.
   * @returns A `Promise` of `SaveResult`, if the action is put, or a `Promise`
   *   of `ModelArtifacts`, if the action is get.
   */
  private databaseAction(modelPath: string, modelArtifacts?: ModelArtifacts):
      Promise<ModelArtifacts|SaveResult> {
    return new Promise<ModelArtifacts|SaveResult>((resolve, reject) => {
      const openRequest = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      openRequest.onupgradeneeded = () => setUpDatabase(openRequest);

      openRequest.onsuccess = () => {
        const db = openRequest.result;

        if (modelArtifacts == null) {
          this.loadModel(db)
            .then((modelArtifacts: ModelArtifacts) => resolve(modelArtifacts))
            .catch((err) => reject(err));
        } else {
          this.saveModel(db, modelArtifacts)
            .then((result: SaveResult) => resolve(result))
            .catch((err) => reject(err));
        }
      };
      openRequest.onerror = error => reject(openRequest.error);
    });
  }

  private loadModel(db: IDBDatabase): Promise<ModelArtifacts> {
    return new Promise (async (resolve, reject) => {
      const modelTx = db.transaction(MODEL_STORE_NAME, 'readonly');
      const modelStore = modelTx.objectStore(MODEL_STORE_NAME);
      let model;

      try {
        model = await this.promisifyRequest(modelStore.get(this.modelPath));
      } catch (error) {
        return reject(error);
      }

      if (model == null) {
        db.close();
        return reject(new Error(
            `Cannot find model with path '${this.modelPath}' ` +
            `in IndexedDB.`));
      }

      const idbModelArtifacts: IDBModelArtifacts = model.modelArtifacts;
      const modelArtifacts = model.modelArtifacts;

      if (idbModelArtifacts.weightChunckKeys !== null) {
        const weightDataChuncked: ArrayBuffer[] = await Promise.all(
            idbModelArtifacts.weightChunckKeys.map(
                async (chunckKey: string) => {
              const weightTx = db.transaction(WEIGHTS_STORE_NAME, 'readwrite');
              const weightsStore = weightTx.objectStore(WEIGHTS_STORE_NAME);
              const weightDataChunck = await this
                .promisifyRequest(weightsStore.get(chunckKey));
              return weightDataChunck.weightData;
          })
        );

        const weightData = concatenateArrayBuffers(weightDataChuncked);
        modelArtifacts.weightData = weightData;
      }

      resolve(modelArtifacts);
    });
  }

  private saveModel(db: IDBDatabase, modelArtifacts: ModelArtifacts):
      Promise<SaveResult> {
    return new Promise (async (resolve, reject) => {
      const modelArtifactsInfo: ModelArtifactsInfo =
      getModelArtifactsInfoForJSON(modelArtifacts);

      // First, put ModelArtifactsInfo into info store.
      const infoTx = db.transaction(INFO_STORE_NAME, 'readwrite');
      const infoStore = infoTx.objectStore(INFO_STORE_NAME);
      let putInfoRequest: IDBRequest;

      try {
        putInfoRequest = await this.promisifyRequest(
          infoStore.put({
            modelPath: this.modelPath,
            modelArtifactsInfo}
          )
        );
      } catch (error) {
        db.close();
        return reject(putInfoRequest.error);
      }

      // Second, store the model weights in chuncks.
      const idbModelArtifacts: IDBModelArtifacts = modelArtifacts;
      idbModelArtifacts.weightData = null;
      idbModelArtifacts.weightChunckKeys = null;

      if (modelArtifacts.weightData !== null) {
        const amountOfChuncks = Math
          .ceil(modelArtifacts.weightData.byteLength / MAX_CHUNCK_SIZE);
        const chunckIds = Array.from(Array(amountOfChuncks).keys())
            .map((item, i) => {
          return `dextr_${i}`;
        });
        idbModelArtifacts.weightChunckKeys = chunckIds;

        try {
          await Promise.all(chunckIds.map(async (chunckId, i) => {
            const weightTx = db.transaction(WEIGHTS_STORE_NAME, 'readwrite');
            const weightsStore = weightTx.objectStore(WEIGHTS_STORE_NAME);

            const start = i * MAX_CHUNCK_SIZE;
            const end = start + MAX_CHUNCK_SIZE <
              modelArtifacts.weightData.byteLength ? start + MAX_CHUNCK_SIZE :
              modelArtifacts.weightData.byteLength;

            const weightData = modelArtifacts.weightData.slice(start, end);

            try {
              await this.promisifyRequest(
                weightsStore.put({
                  chunckId,
                  weightData,
                })
              );
            } catch (err) {
              throw new Error(err);
            }
          }));
        } catch (error) {
          // If the put-model request fails, roll back the info entry as
          // well. If rollback fails, reject with error that triggered the
          // rollback initially.
          this.rollbackArray(db, WEIGHTS_STORE_NAME, chunckIds).catch();
          this.rollback(db, INFO_STORE_NAME, this.modelPath).catch();
          reject(error);
        }
      }

      // Third, put model data into model store.
      const modelTx = db.transaction(MODEL_STORE_NAME, 'readwrite');
      const modelStore = modelTx.objectStore(MODEL_STORE_NAME);
      let putModelRequest: IDBTransaction;

      try {
        putModelRequest = await this.promisifyRequest(
          modelStore.put({
            modelPath: this.modelPath,
            modelArtifacts: idbModelArtifacts,
            modelArtifactsInfo
          })
        );
      } catch (error) {
        // If the put-model request fails, roll back the info entry as
        // well. If rollback fails, reject with error that triggered the
        // rollback initially.
        this.rollback(db, INFO_STORE_NAME, this.modelPath)
          .then(() => reject(putModelRequest.error))
          .catch((err) => reject(putModelRequest.error));
      }

      // close the database
      infoTx.oncomplete = () => {
        if (modelTx == null) {
          db.close();
        } else {
          modelTx.oncomplete = () => db.close();
        }
      };
      resolve({ modelArtifactsInfo });
    });
  }

  private rollbackArray(db: IDBDatabase, storeName: string, keyPaths: string[]):
      Promise<void> {
    return new Promise(async (resolve, reject) => {
      await Promise.all(keyPaths.map(keyPath => {
        this.rollback(db, storeName, keyPath)
          .then(() => resolve())
          .catch(() => reject());
      }));
    });
  }

  private rollback(db: IDBDatabase, storeName: string, keyPath: string):
      Promise<void> {
    return new Promise((resolve, reject) => {
      const storeTx = db.transaction(storeName, 'readwrite');
      const store = storeTx.objectStore(storeName);

      let deleteInfoRequest: IDBRequest;
      try {
        deleteInfoRequest = store.delete(keyPath);
      } catch (err) {
        return reject(err);
      }

      deleteInfoRequest.onsuccess = () => {
        return resolve();
      };
      deleteInfoRequest.onerror = error => {
        return reject(error);
      };
    });
  }

  // TODO: fix type to IDBRequest.result?
  // tslint:disable-next-line:no-any
  private promisifyRequest(req: IDBRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      req.onsuccess = e => resolve(req.result);
      req.onerror = e => reject(req.error);
    });
  }
}

export const indexedDBRouter: IORouter = (url: string|string[]) => {
  if (!env().getBool('IS_BROWSER')) {
    return null;
  } else {
    if (!Array.isArray(url) && url.startsWith(BrowserIndexedDB.URL_SCHEME)) {
      return browserIndexedDB(url.slice(BrowserIndexedDB.URL_SCHEME.length));
    } else {
      return null;
    }
  }
};
IORouterRegistry.registerSaveRouter(indexedDBRouter);
IORouterRegistry.registerLoadRouter(indexedDBRouter);

/**
 * Creates a browser IndexedDB IOHandler for saving and loading models.
 *
 * ```js
 * const model = tf.sequential();
 * model.add(
 *     tf.layers.dense({units: 1, inputShape: [100], activation: 'sigmoid'}));
 *
 * const saveResult = await model.save('indexeddb://MyModel'));
 * console.log(saveResult);
 * ```
 *
 * @param modelPath A unique identifier for the model to be saved. Must be a
 *   non-empty string.
 * @returns An instance of `BrowserIndexedDB` (sublcass of `IOHandler`),
 *   which can be used with, e.g., `tf.Model.save`.
 */
export function browserIndexedDB(modelPath: string): IOHandler {
  return new BrowserIndexedDB(modelPath);
}

function maybeStripScheme(key: string) {
  return key.startsWith(BrowserIndexedDB.URL_SCHEME) ?
      key.slice(BrowserIndexedDB.URL_SCHEME.length) :
      key;
}

export class BrowserIndexedDBManager implements ModelStoreManager {
  private indexedDB: IDBFactory;

  constructor() {
    this.indexedDB = getIndexedDBFactory();
  }

  async listModels(): Promise<{[path: string]: ModelArtifactsInfo}> {
    return new Promise<{[path: string]: ModelArtifactsInfo}>(
        (resolve, reject) => {
          const openRequest =
              this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
          openRequest.onupgradeneeded = () => setUpDatabase(openRequest);

          openRequest.onsuccess = () => {
            const db = openRequest.result;
            const tx = db.transaction(INFO_STORE_NAME, 'readonly');
            const store = tx.objectStore(INFO_STORE_NAME);
            // tslint:disable:max-line-length
            // Need to cast `store` as `any` here because TypeScript's DOM
            // library does not have the `getAll()` method even though the
            // method is supported in the latest version of most mainstream
            // browsers:
            // https://developer.mozilla.org/en-US/docs/Web/API/IDBObjectStore/getAll
            // tslint:enable:max-line-length
            // tslint:disable-next-line:no-any
            const getAllInfoRequest = (store as any).getAll() as IDBRequest;
            getAllInfoRequest.onsuccess = () => {
              const out: {[path: string]: ModelArtifactsInfo} = {};
              for (const item of getAllInfoRequest.result) {
                out[item.modelPath] = item.modelArtifactsInfo;
              }
              resolve(out);
            };
            getAllInfoRequest.onerror = error => {
              db.close();
              return reject(getAllInfoRequest.error);
            };
            tx.oncomplete = () => db.close();
          };
          openRequest.onerror = error => reject(openRequest.error);
        });
  }

  async removeModel(path: string): Promise<ModelArtifactsInfo> {
    path = maybeStripScheme(path);
    return new Promise<ModelArtifactsInfo>((resolve, reject) => {
      const openRequest = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      openRequest.onupgradeneeded = () => setUpDatabase(openRequest);

      openRequest.onsuccess = () => {
        const db = openRequest.result;
        const infoTx = db.transaction(INFO_STORE_NAME, 'readwrite');
        const infoStore = infoTx.objectStore(INFO_STORE_NAME);

        const getInfoRequest = infoStore.get(path);
        let modelTx: IDBTransaction;
        getInfoRequest.onsuccess = () => {
          if (getInfoRequest.result == null) {
            db.close();
            return reject(new Error(
                `Cannot find model with path '${path}' ` +
                `in IndexedDB.`));
          } else {
            // First, delete the entry in the info store.
            const deleteInfoRequest = infoStore.delete(path);
            const deleteModelData = () => {
              // Second, delete the entry in the model store.
              modelTx = db.transaction(MODEL_STORE_NAME, 'readwrite');
              const modelStore = modelTx.objectStore(MODEL_STORE_NAME);
              const deleteModelRequest = modelStore.delete(path);
              deleteModelRequest.onsuccess = () =>
                  resolve(getInfoRequest.result.modelArtifactsInfo);
              deleteModelRequest.onerror = error =>
                  reject(getInfoRequest.error);
            };
            // Proceed with deleting model data regardless of whether deletion
            // of info data succeeds or not.
            deleteInfoRequest.onsuccess = deleteModelData;
            deleteInfoRequest.onerror = error => {
              deleteModelData();
              db.close();
              return reject(getInfoRequest.error);
            };
          }
        };
        getInfoRequest.onerror = error => {
          db.close();
          return reject(getInfoRequest.error);
        };

        infoTx.oncomplete = () => {
          if (modelTx == null) {
            db.close();
          } else {
            modelTx.oncomplete = () => db.close();
          }
        };
      };
      openRequest.onerror = error => reject(openRequest.error);
    });
  }
}

if (env().getBool('IS_BROWSER')) {
  // Wrap the construction and registration, to guard against browsers that
  // don't support Local Storage.
  try {
    ModelStoreManagerRegistry.registerManager(
        BrowserIndexedDB.URL_SCHEME, new BrowserIndexedDBManager());
  } catch (err) {
  }
}
