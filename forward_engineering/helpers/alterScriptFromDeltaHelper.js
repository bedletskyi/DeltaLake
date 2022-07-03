const {
	getAddContainerScript,
	getDeleteContainerScript,
	getModifyContainerScript,
} = require('./alterScriptHelpers/alterContainerHelper');
const {
	getAddCollectionsScripts,
	getDeleteCollectionsScripts,
	getModifyCollectionsScripts,
	getDeleteColumnsScripts,
	getAddColumnsScripts,
	getModifyColumnsScripts,
} = require('./alterScriptHelpers/alterEntityHelper');
const {
	getAddViewsScripts,
	getDeleteViewsScripts,
	getModifyViewsScripts,
} = require('./alterScriptHelpers/alterViewHelper');
const { DROP_STATEMENTS } = require('./constants');
const { commentDeactivatedStatements } = require('./generalHelper');
const sqlFormatter = require('sql-formatter');

const getItems = (entity, nameProperty, modify) =>
	[]
		.concat(entity.properties?.[nameProperty]?.properties?.[modify]?.items)
		.filter(Boolean)
		.map(items => Object.values(items.properties)[0]);

const getAlterContainersScripts = (schema, provider) => {
	const addedScripts = getItems(schema, 'containers', 'added').map(getAddContainerScript);
	const deletedScripts = getItems(schema, 'containers', 'deleted').map(getDeleteContainerScript(provider));
	const modifiedScripts = getItems(schema, 'containers', 'modified').flatMap(getModifyContainerScript(provider));
	return [...addedScripts, ...deletedScripts, ...modifiedScripts];
};

const getAlterCollectionsScripts = (schema, definitions, provider) => {
	const getCollectionScripts = (items, compMode, getScript) =>
		items.filter(item => item.compMod?.[compMode]).flatMap(getScript);

	const getColumnScripts = (items, getScript) => items.filter(item => !item.compMod).flatMap(getScript);

	const addedCollectionsScripts = getCollectionScripts(
		getItems(schema, 'entities', 'added'),
		'created',
		getAddCollectionsScripts(definitions),
	);
	const deletedCollectionsScripts = getCollectionScripts(
		getItems(schema, 'entities', 'deleted'),
		'deleted',
		getDeleteCollectionsScripts(provider),
	);
	const modifiedCollectionsScripts = getCollectionScripts(
		getItems(schema, 'entities', 'modified'),
		'modified',
		getModifyCollectionsScripts(definitions, provider),
	);

	const addedColumnsScripts = getColumnScripts(
		getItems(schema, 'entities', 'added'),
		getAddColumnsScripts(definitions, provider),
	);
	const deletedColumnsScripts = getColumnScripts(
		getItems(schema, 'entities', 'deleted'),
		getDeleteColumnsScripts(definitions, provider),
	);
	const modifiedColumnsScripts = getColumnScripts(
		getItems(schema, 'entities', 'modified'),
		getModifyColumnsScripts(definitions, provider),
	);

	return [
		...addedCollectionsScripts,
		...deletedCollectionsScripts,
		...modifiedCollectionsScripts,
		...addedColumnsScripts,
		...deletedColumnsScripts,
		...modifiedColumnsScripts,
	];
};

const getAlterViewsScripts = (schema, provider) => {
	const getViewScripts = (views, compMode, getScript) =>
		views
			.map(view => ({ ...view, ...(view.role || {}) }))
			.filter(view => view.compMod?.[compMode])
			.map(getScript);

	const getColumnScripts = (items, getScript) =>
		items
			.map(view => ({ ...view, ...(view.role || {}) }))
			.filter(view => !view.compMod?.created && !view.compMod?.deleted)
			.flatMap(getScript);

	const addedViewScripts = getViewScripts(getItems(schema, 'views', 'added'), 'created', getAddViewsScripts);
	const deletedViewScripts = getViewScripts(
		getItems(schema, 'views', 'deleted'),
		'deleted',
		getDeleteViewsScripts(provider),
	);
	const modifiedViewScripts = getColumnScripts(
		getItems(schema, 'views', 'modified'),
		getModifyViewsScripts(provider),
	);

	return [...addedViewScripts, ...deletedViewScripts, ...modifiedViewScripts];
};

const getAlterScript = (schema, definitions, data, app) => {
	const provider = require('./alterScriptHelpers/provider')(app);
	const containersScripts = getAlterContainersScripts(schema, provider);
	const collectionsScripts = getAlterCollectionsScripts(schema, definitions, provider);
	const viewsScripts = getAlterViewsScripts(schema, provider);
	let scripts = containersScripts
		.concat(collectionsScripts, viewsScripts)
		.filter(Boolean)
		.map(script => script.trim());
	scripts = getCommentedDropScript(scripts, data);
	return builds(scripts);
};

const getCommentedDropScript = (scripts, data) => {
	const { additionalOptions = [] } = data.options || {};
	const applyDropStatements = (additionalOptions.find(option => option.id === 'applyDropStatements') || {}).value;
	if (applyDropStatements) {
		return scripts;
	}
	return scripts.map(script => {
		const isDrop = DROP_STATEMENTS.some(statement => script.includes(statement));
		return !isDrop ? script : commentDeactivatedStatements(script, false);
	});
};

const builds = scripts => {
	const formatScripts = sqlFormatter.format(scripts.filter(Boolean).join('\n\n'), { indent: '    ' });
	return formatScripts
		.split(';')
		.map(script => script.trim())
		.join(';\n\n');
};

module.exports = {
	getAlterScript,
};
