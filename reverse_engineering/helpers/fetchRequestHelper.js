'use strict'
const fetch = require('node-fetch');
const { dependencies } = require('../appDependencies');
const { getDatabasesTablesCode, getClusterData, getDocuments } = require('./ScalaGeneratorHelper')
let activeContext;

const destroyActiveContext = () => {
	destroyContext(activeContext.connectionInfo, activeContext.id)
	activeContext = undefined;
}


const fetchApplyToInstance = async (connectionInfo, logger) => {
	const scriptWithoutNewLineSymb = connectionInfo.script.replaceAll(/[\s]+/g, " ");
	const eachEntityScript = scriptWithoutNewLineSymb.split(';').filter(script => script !== '');
	const progress = (message) => {
		logger.log('info', message, 'Applying to instande');
		logger.progress(message);
	};
	for (let script of eachEntityScript) {
		progress({ message: `Applying script: \n ${script}` });
		const command = `var stmt = sqlContext.sql("${script}")`;
		await Promise.race([executeCommand(connectionInfo, command), new Promise((_r, rej) => setTimeout(() => { throw new Error("Timeout exceeded for script\n" + script); }, connectionInfo.applyToInstanceQueryRequestTimeout || 120000))])
	}
}

const fetchDocuments = async ({ connectionInfo, dbName, tableName, fields, isAbsolute, percentage, absoluteNumber }) => {
	try {
		const columnsToSelect = fields.map(field => field.name).join(', ');
		const fetchDocumentsCommand = getDocuments({
			dbName,
			tableName,
			isAbsolute,
			percentage,
			absoluteNumber,
			columnsToSelect
		})
		const result = await executeCommand(connectionInfo, fetchDocumentsCommand);
		const rowsExtractionRegex = /(rows: Array\[String\] = Array\((.+)\))/gm
		const rowsJSON = dependencies.lodash.get(rowsExtractionRegex.exec(result), '2', '')
		const rows = JSON.parse(`[${rowsJSON}]`);
		return rows;
	} catch (e) {
		return [];
	}
}

const fetchClusterProperties = async (connectionInfo) => {
	const query = connectionInfo.host + `/api/2.0/clusters/get?cluster_id=${connectionInfo.clusterId}`;
	const options = getRequestOptions(connectionInfo)
	return await fetch(query, options)
		.then(response => {
			if (response.ok) {
				return response.text()
			}
			throw {
				message: response.statusText, code: response.status, description: ''
			};
		})
		.then(body => {
			try {
				return JSON.parse(body);
			} catch (e) {
				throw {
					message: e.message, code: "", description: 'body: ' + body
				};
			}
		})
}
const fetchClusterDatabasesNames = async (connectionInfo) => {
	const result = await executeCommand(connectionInfo, "SHOW DATABASES", 'sql');
	return dependencies.lodash.flattenDeep(result);
}


const fetchClusterViewsNames = (connectionInfo) => executeCommand(connectionInfo, "SHOW VIEWS", 'sql');


const fetchClusterTablesNames = (connectionInfo) => executeCommand(connectionInfo, "SHOW TABLES", 'sql');

const fetchClusterData = async (connectionInfo, tablesNames, databasesNames, logger) => {
	const getClusterDataCommand = getClusterData(tablesNames, databasesNames);
	const result = await executeCommand(connectionInfo, getClusterDataCommand);
	const formattedResult = result.split('clusterData: String =')[1]
		.replaceAll('\n', ' ')
		.replaceAll('\\n', '')
		.replaceAll('"{', '{')
		.replaceAll('"[', '[')
		.replaceAll('}"', '}')
		.replaceAll('\\"', '"')
		.replaceAll(']"', ']');
	try {
		return JSON.parse(formattedResult);
	} catch (error) {
		logger.log('error', { error }, `\nDatabricks response: ${result}\n\nFormatted result: ${formattedResult}\n`);
		throw error;
	}
}

const fetchCreateStatementRequest = async (command, connectionInfo) => {
	const result = await executeCommand(connectionInfo, command);

	const statementExtractionRegex = /stmt: String = "(.+)"/gm;
	const resultWithoutNewLineSymb = result.replaceAll(/[\n\r]/g, " ");
	const entityCreateStatement = statementExtractionRegex.exec(resultWithoutNewLineSymb);

	return dependencies.lodash.get(entityCreateStatement, '1', '')
}

const getRequestOptions = (connectionInfo) => {
	const headers = {
		'Authorization': 'Bearer ' + connectionInfo.accessToken
	};

	return {
		'method': 'GET',
		'headers': headers
	};
}

const postRequestOptions = (connectionInfo, body) => {
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': 'Bearer ' + connectionInfo.accessToken
	};

	return {
		'method': 'POST',
		headers,
		body
	}
};

const createContext = (connectionInfo) => {
	if (activeContext) {
		return Promise.resolve(activeContext.id);
	}
	const query = connectionInfo.host + '/api/1.2/contexts/create'
	const body = JSON.stringify({
		"language": "scala",
		"clusterId": connectionInfo.clusterId
	})
	const options = postRequestOptions(connectionInfo, body);

	return fetch(query, options)
		.then(response => {
			if (response.ok) {
				return response.text()
			}
			throw {
				message: response.statusText, code: response.status, description: body
			};
		})
		.then(body => {
			body = JSON.parse(body);
			activeContext = {
				id: body.id,
				connectionInfo
			}
			return activeContext.id;
		})
}

const destroyContext = (connectionInfo, contextId) => {
	const query = connectionInfo.host + '/api/1.2/contexts/destroy'
	const body = JSON.stringify({
		"contextId": contextId,
		"clusterId": connectionInfo.clusterId
	});
	const options = postRequestOptions(connectionInfo, body);
	return fetch(query, options)
		.then(response => {
			if (response.ok) {
				return response.text()
			}
			throw {
				message: response.statusText, code: response.status, description: body
			};
		})
		.then(body => {
			body = JSON.parse(body);
		});
}

const executeCommand = (connectionInfo, command, language = "scala") => {

	let activeContextId;

	return createContext(connectionInfo)
		.then(contextId => {
			activeContextId = contextId;
			const query = connectionInfo.host + '/api/1.2/commands/execute';
			const body = JSON.stringify({
				language,
				clusterId: connectionInfo.clusterId,
				contextId,
				command
			});
			const options = postRequestOptions(connectionInfo, body)

			return fetch(query, options)
				.then(response => {
					if (response.ok) {
						return response.text()
					}
					throw {
						message: response.statusText, code: response.status, description: body
					};
				})
				.then(body => {

					body = JSON.parse(body);

					const query = new URL(connectionInfo.host + '/api/1.2/commands/status');
					const params = {
						clusterId: connectionInfo.clusterId,
						contextId: activeContextId,
						commandId: body.id
					}
					query.search = new URLSearchParams(params).toString();
					const options = getRequestOptions(connectionInfo);
					return getCommandExecutionResult(query, options);
				})
		}
		)
}

const getCommandExecutionResult = (query, options) => {
	return fetch(query, options)
		.then(response => {
			if (response.ok) {
				return response.text()
			}
			throw {
				message: response.statusText, code: response.status, description: body
			};
		})
		.then(body => {
			body = JSON.parse(body);
			if (body.status === 'Finished' && body.results !== null) {
				if (body.results.resultType === 'error') {
					throw {
						message: body.results.data || body.results.cause, code: "", description: ""
					};
				}
				return body.results.data;
			}

			if (body.status === 'Error') {
				throw {
					message: "Error during receiving command result", code: "", description: ""
				};
			}
			return getCommandExecutionResult(query, options);
		})
}

module.exports = {
	fetchClusterProperties,
	fetchApplyToInstance,
	fetchDocuments,
	destroyActiveContext,
	fetchClusterData,
	fetchCreateStatementRequest,
	fetchClusterDatabasesNames,
	fetchClusterViewsNames,
	fetchClusterTablesNames
};