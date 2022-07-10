'use strict';

const { setDependencies, dependencies } = require('./helpers/appDependencies');
const { getDatabaseStatement } = require('./helpers/databaseHelper');
const { getTableStatement } = require('./helpers/tableHelper');
const { getIndexes } = require('./helpers/indexHelper');
const { getViewScript } = require('./helpers/viewHelper');
const { getCleanedUrl } = require('./helpers/generalHelper');
let _;
const fetchRequestHelper = require('../reverse_engineering/helpers/fetchRequestHelper');
const databricksHelper = require('../reverse_engineering/helpers/databricksHelper');
const logHelper = require('../reverse_engineering/logHelper');
const { getAlterScript } = require('./helpers/alterScriptFromDeltaHelper');
const sqlFormatter = require('sql-formatter');
const { DROP_STATEMENTS } = require('./helpers/constants');

const setAppDependencies = ({ lodash }) => (_ = lodash);

module.exports = {
	generateScript(data, logger, callback, app) {
		try {
			setDependencies(app);
			setAppDependencies(dependencies);
			const jsonSchema = JSON.parse(data.jsonSchema);
			const modelDefinitions = JSON.parse(data.modelDefinitions);
			const internalDefinitions = JSON.parse(data.internalDefinitions);
			const externalDefinitions = JSON.parse(data.externalDefinitions);
			const containerData = data.containerData;
			const entityData = data.entityData;
			const areColumnConstraintsAvailable = data.modelData[0].dbVersion.startsWith('3');
			const areForeignPrimaryKeyConstraintsAvailable = !data.modelData[0].dbVersion.startsWith('1');
			let scripts = '';

			if (data.isUpdateScript) {
				const definitions = [modelDefinitions, internalDefinitions, externalDefinitions];
				scripts = getAlterScript(jsonSchema, definitions, data, app);
			} else {
				const databaseStatement = getDatabaseStatement(containerData);
				const tableStatements = getTableStatement(
					containerData,
					entityData,
					jsonSchema,
					[modelDefinitions, internalDefinitions, externalDefinitions],
					null,
					areColumnConstraintsAvailable,
					areForeignPrimaryKeyConstraintsAvailable,
				);
				scripts = buildScript(
					databaseStatement,
					tableStatements,
					getIndexes(containerData, entityData, jsonSchema, [
						modelDefinitions,
						internalDefinitions,
						externalDefinitions,
					]),
				);
			}
			callback(null, scripts);
		} catch (e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'DeltaLake Forward-Engineering Error');

			setTimeout(() => {
				callback({ message: e.message, stack: e.stack });
			}, 150);
		}
	},

	generateContainerScript(data, logger, callback, app) {
		try {
			setDependencies(app);
			setAppDependencies(dependencies);
			const containerData = data.containerData;
			const modelDefinitions = JSON.parse(data.modelDefinitions);
			const externalDefinitions = JSON.parse(data.externalDefinitions);
			const jsonSchema = parseEntities(data.entities, data.jsonSchema);
			const internalDefinitions = parseEntities(data.entities, data.internalDefinitions);
			const areColumnConstraintsAvailable = data.modelData[0].dbVersion.startsWith('3');
			const areForeignPrimaryKeyConstraintsAvailable = !data.modelData[0].dbVersion.startsWith('1');

			if (data.isUpdateScript) {
				const deltaModelSchema = _.first(Object.values(jsonSchema)) || {};
				const definitions = [modelDefinitions, internalDefinitions, externalDefinitions];
				const scripts = getAlterScript(deltaModelSchema, definitions, data, app);
				callback(null, scripts);
				return;
			}

			const databaseStatement = getDatabaseStatement(containerData);
			let viewsScripts = data.views.map(viewId => {
				const viewSchema = JSON.parse(data.jsonSchema[viewId] || '{}');
				return getViewScript({
					schema: viewSchema,
					viewData: data.viewData[viewId],
					containerData: data.containerData,
					collectionRefsDefinitionsMap: data.collectionRefsDefinitionsMap,
					isKeyspaceActivated: true,
				});
			});

			viewsScripts = viewsScripts.filter(script => !dependencies.lodash.isEmpty(script));

			const entities = data.entities.reduce((result, entityId) => {
				const args = [
					containerData,
					data.entityData[entityId],
					jsonSchema[entityId],
					[internalDefinitions[entityId], modelDefinitions, externalDefinitions],
					true,
				];

				const tableStatement = getTableStatement(
					...args,
					null,
					areColumnConstraintsAvailable,
					areForeignPrimaryKeyConstraintsAvailable,
				);

				return result.concat([tableStatement, getIndexes(...args)]);
			}, []);

			const scripts = buildScript(databaseStatement, ...entities, ...viewsScripts);

			callback(null, scripts);
		} catch (e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'Hive Forward-Engineering Error');

			setTimeout(() => {
				callback({ message: e.message, stack: e.stack });
			}, 150);
		}
	},

	async applyToInstance(connectionInfo, logger, cb, app) {
		logger.clear();
		logInfo('info', connectionInfo, logger);

		const connectionData = {
			host: getCleanedUrl(connectionInfo.host),
			clusterId: connectionInfo.clusterId,
			accessToken: connectionInfo.accessToken,
			applyToInstanceQueryRequestTimeout: connectionInfo.applyToInstanceQueryRequestTimeout,
			script: connectionInfo.script,
		};

		try {
			await fetchRequestHelper.fetchApplyToInstance(connectionData, logger);
			cb();
		} catch (err) {
			logger.log('error', { message: err.message, stack: err.stack, error: err }, 'Apply to instance');
			cb({ message: err.message, stack: err.stack });
		}
	},

	async testConnection(connectionInfo, logger, cb) {
		try {
			logInfo('Test connection FE', connectionInfo, logger);

			const connectionData = {
				host: getCleanedUrl(connectionInfo.host),
				clusterId: connectionInfo.clusterId,
				accessToken: connectionInfo.accessToken,
			};

			const clusterState = await databricksHelper.getClusterStateInfo(connectionData, logger);
			logger.log('info', clusterState, 'Cluster state info');

			if (!clusterState.isRunning) {
				cb({ message: `Cluster is unavailable. Cluster status: ${clusterState.state}`, type: 'simpleError' });
			}
			cb();
		} catch (err) {
			logger.log('error', { message: err.message, stack: err.stack, error: err }, 'Test connection FE');
			cb({ message: err.message, stack: err.stack });
		}
	},

	isDropInStatements(data, logger, cb, app) {
		const callback = (error, script = '') => {
			cb(
				error,
				DROP_STATEMENTS.some(statement => script.includes(statement)),
			);
		};

		try {
			setDependencies(app);

			if (data.level === 'container') {
				this.generateContainerScript(data, logger, callback, app);
			} else if (data.level === 'entity') {
				this.generateScript(data, logger, callback, app);
			}
		} catch (e) {
			callback({ message: e.message, stack: e.stack });
		}
	},
};

const buildScript = (...statements) => {
	const script = statements.filter(statement => statement).join('\n\n');
	return sqlFormatter.format(script, { indent: '    ' }) + '\n';
};

const parseEntities = (entities, serializedItems) => {
	return entities.reduce((result, entityId) => {
		try {
			return Object.assign({}, result, {
				[entityId]: JSON.parse(serializedItems[entityId]),
			});
		} catch (e) {
			return result;
		}
	}, {});
};
const logInfo = (step, connectionInfo, logger) => {
	logger.clear();
	logger.log('info', logHelper.getSystemInfo(connectionInfo), step);
	logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);
};
