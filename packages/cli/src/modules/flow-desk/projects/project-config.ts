import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import type { ProjectWorkflowConfig } from '../contracts/generated';

export type ProjectFlow = {
	exposure?: 'normal' | 'test-only';
	id: string;
	parameters?: Record<string, unknown>;
	nodes: Array<{ id: string; name: string; type: string; parameters: Record<string, unknown> }>;
	connections: Record<
		string,
		{ main: Array<Array<{ node: string; type?: string; index?: number }>> }
	>;
	limits?: { maxSteps?: number; maxDurationMs?: number };
};
export type ProjectSnapshot = {
	projectId: string;
	flowId: string;
	config: ProjectWorkflowConfig;
	flow: ProjectFlow;
	flows: Record<string, ProjectFlow>;
	params: Record<string, unknown>;
	prompts: Record<string, string>;
	skills: Record<string, Record<string, string>>;
	schemas: Record<string, Record<string, unknown>>;
	files: Record<string, string>;
	contentHash: string;
};
const projectId = /^[a-z][a-z0-9-]{0,63}$/;
const capabilities = new Set([
	'start',
	'workspace',
	'command',
	'service',
	'agent',
	'verify',
	'approval',
	'work-item',
	'integrate',
	'subflow',
	'notify',
	'finish',
	'if',
	'switch',
	'merge',
]);

export function contentDigest(value: unknown): string {
	function canonical(item: unknown): unknown {
		if (Array.isArray(item)) return item.map(canonical);
		if (item && typeof item === 'object')
			return Object.fromEntries(
				Object.entries(item)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, val]) => [key, canonical(val)]),
			);
		return item;
	}
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex');
}
function readInside(base: string, rel: string): { file: string; text: string } {
	if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.includes('\0'))
		throw new Error('Project path must be relative');
	const file = realpathSync(path.resolve(base, rel));
	const relative = path.relative(base, file);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error('Project path escapes configuration');
	if (statSync(file).size > 2 * 1024 * 1024 || !statSync(file).isFile())
		throw new Error('Invalid project configuration file');
	return { file, text: readFileSync(file, 'utf8') };
}
export function validateProjectFlow(flow: ProjectFlow): void {
	if (flow.exposure && !['normal', 'test-only'].includes(flow.exposure))
		throw new Error('Invalid flow exposure');
	if (!Array.isArray(flow.nodes) || !flow.nodes.length || !flow.connections)
		throw new Error('Invalid project flow');
	const ids = new Set<string>(),
		names = new Set<string>();
	const catalog = JSON.parse(
		readFileSync(path.resolve(__dirname, '../contracts/node-catalog.json'), 'utf8'),
	) as Array<{ type: string; inputSchema: string }>;
	for (const node of flow.nodes) {
		{
			const schemaName =
				node.type === 'if'
					? 'workflow-condition-params'
					: catalog.find((entry) => entry.type === node.type)?.inputSchema;
			if (!schemaName) throw new Error('Unsupported project control capability');
			const schema = JSON.parse(
				readFileSync(path.resolve(__dirname, `../contracts/${schemaName}.schema.json`), 'utf8'),
			);
			if (!new Ajv({ strict: false }).compile(schema)(node.parameters))
				throw new Error(`Invalid ${node.type} parameters`);
		}
		if (
			!node.id ||
			['__proto__', 'constructor', 'prototype'].includes(node.id) ||
			!node.name ||
			ids.has(node.id) ||
			names.has(node.name) ||
			!capabilities.has(node.type)
		)
			throw new Error('Invalid or duplicate project node');
		ids.add(node.id);
		names.add(node.name);
	}
	if (flow.nodes.filter((node) => node.type === 'start').length !== 1)
		throw new Error('A flow needs one start node');
	for (const [from, connection] of Object.entries(flow.connections)) {
		if (!names.has(from) || !Array.isArray(connection.main)) throw new Error('Invalid flow source');
		for (const branch of connection.main)
			for (const target of branch)
				if (!names.has(target.node)) throw new Error('Invalid flow target');
	}
}
export function loadProjectSnapshot(input: {
	root: string;
	projectId: string;
	flowId: string;
	params?: Record<string, unknown>;
}): ProjectSnapshot {
	const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: true });
	if (!projectId.test(input.projectId) || !projectId.test(input.flowId))
		throw new Error('Invalid project or flow id');
	const projects = realpathSync(path.join(input.root, 'projects'));
	const base = realpathSync(path.join(projects, input.projectId));
	if (path.dirname(base) !== projects) throw new Error('Project directory escapes root');
	const files: Record<string, string> = {};
	const read = (rel: string) => {
		const { text } = readInside(base, rel);
		files[rel] = text;
		return text;
	};
	const config = parse(read('project.yaml'), { maxAliasCount: 50 }) as ProjectWorkflowConfig;
	// The copied schema is generated from packages/contracts and loaded by the owning fork.
	const schema = JSON.parse(
		readFileSync(path.resolve(__dirname, '../contracts/project-workflow.schema.json'), 'utf8'),
	) as object;
	const validate = ajv.compile(schema);
	if (!validate(config) || config.projectId !== input.projectId)
		throw new Error(`Invalid project configuration: ${ajv.errorsText(validate.errors)}`);
	for (const ref of config.preparation.commands)
		if (!config.commands?.[ref]) throw new Error('Unknown preparation command');
	for (const ref of config.preparation.services)
		if (!config.services?.[ref]) throw new Error('Unknown preparation service');
	for (const suite of Object.values(config.verification))
		if (!config.commands?.[suite.commandRef]) throw new Error('Unknown verification command');
	const flowPath = config.flows[input.flowId];
	if (!flowPath) throw new Error('Unknown project flow');
	const flows = Object.fromEntries(
		Object.entries(config.flows).map(([id, ref]) => {
			const definition = JSON.parse(read(ref)) as ProjectFlow;
			if (definition.id !== id) throw new Error('Flow id does not match project reference');
			validateProjectFlow(definition);
			return [id, definition];
		}),
	);
	const flow = flows[input.flowId];
	const params = structuredClone(input.params ?? {}) as Record<string, unknown>;
	const parameterSchema = flow.parameters ?? {
		type: 'object',
		additionalProperties: false,
		properties: {},
	};
	const validateParams = ajv.compile(parameterSchema);
	for (const key of Object.keys((parameterSchema.properties ?? {}) as object))
		if (!Object.hasOwn(params, key) && Object.hasOwn(config.defaults ?? {}, key))
			params[key] = structuredClone(config.defaults![key]);
	if (!validateParams(params))
		throw new Error(`Invalid runtime parameters: ${ajv.errorsText(validateParams.errors)}`);
	// Reject unknown keys even when a project forgets additionalProperties:false.
	const known = (parameterSchema.properties ?? {}) as Record<string, unknown>;
	if (Object.keys(params).some((key) => !Object.hasOwn(known, key)))
		throw new Error('Undeclared runtime parameter');
	const prompts = Object.fromEntries(
		Object.entries(config.prompts).map(([id, rel]) => [id, read(rel)]),
	);
	const schemas = Object.fromEntries(
		Object.entries(config.schemas).map(([id, rel]) => {
			const result = JSON.parse(read(rel)) as Record<string, unknown>;
			ajv.compile(result);
			return [id, result];
		}),
	);
	const skills: Record<string, Record<string, string>> = {};
	for (const [id, ref] of Object.entries(config.skills)) {
		const skillFiles: Record<string, string> = {};
		const skillBase = realpathSync(path.resolve(base, ref.path));
		if (!skillBase.startsWith(base + path.sep)) throw new Error('Skill escapes project');
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(file);
				else {
					const rel = path.relative(base, file);
					skillFiles[path.relative(skillBase, file).split(path.sep).join('/')] = read(rel);
				}
			}
		};
		walk(skillBase);
		if (!skillFiles['SKILL.md']) throw new Error('Missing SKILL.md');
		if (ref.hash && ref.hash !== contentDigest(skillFiles))
			throw new Error('Skill content hash mismatch');
		skills[id] = skillFiles;
	}
	for (const definition of Object.values(flows))
		for (const node of definition.nodes) {
			const p = node.parameters;
			if (node.type === 'agent' && (!prompts[String(p.promptRef)] || !schemas[String(p.schemaRef)]))
				throw new Error('Unknown Agent prompt or schema');
			if (
				node.type === 'agent' &&
				Array.isArray(p.skillRefs) &&
				p.skillRefs.some((id) => !skills[String(id)])
			)
				throw new Error('Unknown allowed skill');
			if (
				node.type === 'command' &&
				!p.managedCli &&
				typeof p.command !== 'string' &&
				!config.commands?.[String(p.commandRef)]
			)
				throw new Error('Unknown command');
			if (node.type === 'service' && !config.services?.[String(p.serviceRef)])
				throw new Error('Unknown service');
			if (node.type === 'subflow' && !config.flows[String(p.flowRef)])
				throw new Error('Unknown subflow');
			if (
				node.type === 'verify' &&
				Array.isArray(p.suites) &&
				p.suites.some((ref) => !config.verification[String(ref)])
			)
				throw new Error('Unknown verification suite');
			if (
				node.type === 'verify' &&
				Array.isArray(p.resolves) &&
				p.resolves.some(
					(id) =>
						!definition.nodes.some(
							(item) => item.id === id && ['agent', 'verify'].includes(item.type),
						),
				)
			)
				throw new Error('Unknown or non-recoverable verification resolution target');
		}
	const snapshot = {
		projectId: input.projectId,
		flowId: input.flowId,
		config,
		flow,
		flows,
		params,
		prompts,
		skills,
		schemas,
		files,
	};
	const result = {
		...snapshot,
		contentHash: contentDigest({
			projectId: input.projectId,
			config,
			flows,
			prompts,
			skills,
			schemas,
			files,
		}),
	};
	const freeze = (value: unknown) => {
		if (value && typeof value === 'object' && !Object.isFrozen(value)) {
			Object.freeze(value);
			for (const item of Object.values(value)) freeze(item);
		}
	};
	freeze(result);
	return result;
}

export function bindProjectFlow(
	snapshot: ProjectSnapshot,
	flowId: string,
	supplied: Record<string, unknown> = {},
): ProjectSnapshot {
	const flow = snapshot.flows[flowId];
	if (!flow) throw new Error('Unknown approved project flow');
	const params = structuredClone(supplied) as Record<string, unknown>;
	const schema = flow.parameters ?? { type: 'object', additionalProperties: false, properties: {} };
	for (const key of Object.keys((schema.properties ?? {}) as object))
		if (!Object.hasOwn(params, key) && Object.hasOwn(snapshot.config.defaults ?? {}, key))
			params[key] = structuredClone(snapshot.config.defaults![key]);
	const validate = new Ajv({ strict: false, allErrors: true, useDefaults: true }).compile(schema);
	if (!validate(params)) throw new Error('Invalid runtime parameters');
	const known = (schema.properties ?? {}) as Record<string, unknown>;
	if (Object.keys(params).some((key) => !Object.hasOwn(known, key)))
		throw new Error('Undeclared runtime parameter');
	return { ...snapshot, flowId, flow, params };
}
