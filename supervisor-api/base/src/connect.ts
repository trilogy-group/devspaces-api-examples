require('reflect-metadata');
import { GitpodClient, GitpodServer, GitpodServiceImpl, WorkspaceInstanceUpdateListener } from '@gitpod/gitpod-protocol/lib/gitpod-service';
import { JsonRpcProxyFactory } from '@gitpod/gitpod-protocol/lib/messaging/proxy-factory';
import { /*NavigatorContext,*/ User } from '@gitpod/gitpod-protocol/lib/protocol';
//import { ErrorCodes } from '@gitpod/gitpod-protocol/lib/messaging/error';
//import { GitpodHostUrl } from '@gitpod/gitpod-protocol/lib/util/gitpod-host-url';
import { ControlServiceClient } from '@gitpod/supervisor-api-grpc/lib/control_grpc_pb';
import { InfoServiceClient } from '@gitpod/supervisor-api-grpc/lib/info_grpc_pb';
import { WorkspaceInfoRequest, WorkspaceInfoResponse } from '@gitpod/supervisor-api-grpc/lib/info_pb';
import { NotificationServiceClient } from '@gitpod/supervisor-api-grpc/lib/notification_grpc_pb';
//import { NotifyRequest, NotifyResponse, RespondRequest, SubscribeRequest, SubscribeResponse } from '@gitpod/supervisor-api-grpc/lib/notification_pb';
import { PortServiceClient } from '@gitpod/supervisor-api-grpc/lib/port_grpc_pb';
import { StatusServiceClient } from '@gitpod/supervisor-api-grpc/lib/status_grpc_pb';
import { ContentStatusRequest, /*TasksStatusRequest, TasksStatusResponse, TaskState, TaskStatus*/ } from '@gitpod/supervisor-api-grpc/lib/status_pb';
import { TerminalServiceClient } from '@gitpod/supervisor-api-grpc/lib/terminal_grpc_pb';
//import { ListenTerminalRequest, ListenTerminalResponse, ListTerminalsRequest, SetTerminalSizeRequest, ShutdownTerminalRequest, Terminal as SupervisorTerminal, TerminalSize as SupervisorTerminalSize, WriteTerminalRequest } from '@gitpod/supervisor-api-grpc/lib/terminal_pb';
import { TokenServiceClient } from '@gitpod/supervisor-api-grpc/lib/token_grpc_pb';
import { GetTokenRequest } from '@gitpod/supervisor-api-grpc/lib/token_pb';
import * as grpc from '@grpc/grpc-js';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { URL } from 'url';
import * as util from 'util';
import { /*CancellationToken,*/ ConsoleLogger, listen as doListen } from 'vscode-ws-jsonrpc';
import WebSocket = require('ws');
import * as uuid from 'uuid';

export class SupervisorConnection {
	readonly deadlines = {
		long: 30 * 1000,
		normal: 15 * 1000,
		short: 5 * 1000
	};
	private readonly addr = process.env.SUPERVISOR_ADDR || 'localhost:22999';
	private readonly clientOptions: Partial<grpc.ClientOptions>;
	readonly metadata = new grpc.Metadata();
	readonly status: StatusServiceClient;
	readonly control: ControlServiceClient;
	readonly notification: NotificationServiceClient;
	readonly token: TokenServiceClient;
	readonly info: InfoServiceClient;
	readonly port: PortServiceClient;
	readonly terminal: TerminalServiceClient;

	constructor(
	) {
		this.clientOptions = {
			'grpc.primary_user_agent': `api-sample`,
		};
		this.status = new StatusServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.control = new ControlServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.notification = new NotificationServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.token = new TokenServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.info = new InfoServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.port = new PortServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
		this.terminal = new TerminalServiceClient(this.addr, grpc.credentials.createInsecure(), this.clientOptions);
	}
}

type UsedGitpodFunction = ['getWorkspace', 'openPort', 'stopWorkspace', 'setWorkspaceTimeout', 'getWorkspaceTimeout', 'getLoggedInUser', 'takeSnapshot', 'waitForSnapshot', 'controlAdmission', 'sendHeartBeat', 'trackEvent'];
type Union<Tuple extends any[], Union = never> = Tuple[number] | Union;
export type GitpodConnection = Omit<GitpodServiceImpl<GitpodClient, GitpodServer>, 'server'> & {
	server: Pick<GitpodServer, Union<UsedGitpodFunction>>;
};

export class GitpodExtensionContext {

	readonly sessionId = uuid.v4();
	readonly pendingActivate: Promise<void>[] = [];
	readonly workspaceContextUrl: string;

	constructor(
		readonly devMode: boolean,
		readonly supervisor: SupervisorConnection,
		readonly gitpod: GitpodConnection,
		private readonly webSocket: Promise<ReconnectingWebSocket> | undefined,
		readonly pendingWillCloseSocket: (() => Promise<void>)[],
		readonly info: WorkspaceInfoResponse,
		readonly owner: Promise<User>,
		readonly user: Promise<User>,
		readonly instanceListener: Promise<WorkspaceInstanceUpdateListener>,
		readonly workspaceOwned: Promise<boolean>
	) {
		this.workspaceContextUrl = info.getWorkspaceContextUrl();
	}

	get active() {
		Object.freeze(this.pendingActivate);
		return Promise.all(this.pendingActivate.map(p => p.catch(console.error)));
	}


	dispose() {
		const pendingWebSocket = this.webSocket;
		if (!pendingWebSocket) {
			return;
		}
		return (async () => {
			try {
				const webSocket = await pendingWebSocket;
				await Promise.allSettled(this.pendingWillCloseSocket.map(f => f()));
				webSocket.close();
			} catch (e) {
				console.error('failed to dispose context:', e);
			}
		})();
	}

}

export async function createGitpodExtensionContext(): Promise<GitpodExtensionContext | undefined> {
	const devMode = !!process.env['VSCODE_DEV'];

	const supervisor = new SupervisorConnection();

	let contentAvailable = false;
	while (!contentAvailable) {
		try {
			const contentStatusRequest = new ContentStatusRequest();
			contentStatusRequest.setWait(true);
			const result = await util.promisify(supervisor.status.contentStatus.bind(supervisor.status, contentStatusRequest, supervisor.metadata, {
				deadline: Date.now() + supervisor.deadlines.long
			}))();
			contentAvailable = result.getAvailable();
		} catch (e) {
			if (e.code === grpc.status.UNAVAILABLE) {
				console.info('It does not look like we are running in a Gitpod workspace, supervisor is not available.');
				return undefined;
			}
			console.error('cannot maintain connection to supervisor', e);
		}
	}

	const workspaceInfo = await util.promisify(supervisor.info.workspaceInfo.bind(supervisor.info, new WorkspaceInfoRequest(), supervisor.metadata, {
		deadline: Date.now() + supervisor.deadlines.long
	}))();

	const workspaceId = workspaceInfo.getWorkspaceId();
	const gitpodHost = workspaceInfo.getGitpodHost();
	const gitpodApi = workspaceInfo.getGitpodApi()!;

	const factory = new JsonRpcProxyFactory<GitpodServer>();
	const gitpodFunctions: UsedGitpodFunction = ['getWorkspace', 'openPort', 'stopWorkspace', 'setWorkspaceTimeout', 'getWorkspaceTimeout', 'getLoggedInUser', 'takeSnapshot', 'waitForSnapshot', 'controlAdmission', 'sendHeartBeat', 'trackEvent'];
	const gitpodService: GitpodConnection = new GitpodServiceImpl<GitpodClient, GitpodServer>(factory.createProxy()) as any;
	const gitpodScopes = new Set<string>([
		'resource:workspace::' + workspaceId + '::get/update',
		'function:accessCodeSyncStorage',
	]);
	for (const gitpodFunction of gitpodFunctions) {
		gitpodScopes.add('function:' + gitpodFunction);
	}
	const pendingServerToken = (async () => {
		const getTokenRequest = new GetTokenRequest();
		getTokenRequest.setKind('gitpod');
		getTokenRequest.setHost(gitpodApi.getHost());
		for (const scope of gitpodScopes) {
			getTokenRequest.addScope(scope);
		}
		const getTokenResponse = await util.promisify(supervisor.token.getToken.bind(supervisor.token, getTokenRequest, supervisor.metadata, {
			deadline: Date.now() + supervisor.deadlines.long
		}))();
		return getTokenResponse.getToken();
	})();
	const pendingWillCloseSocket: (() => Promise<void>)[] = [];
	const pendingWebSocket = (async () => {
		const serverToken = await pendingServerToken;
		class GitpodServerWebSocket extends WebSocket {
			constructor(address: string, protocols?: string | string[]) {
				super(address, protocols, {
					headers: {
						'Origin': new URL(gitpodHost).origin,
						'Authorization': `Bearer ${serverToken}`,
						'User-Agent': `api-example`,
					}
				});
			}
		}
		const webSocket = new ReconnectingWebSocket(gitpodApi.getEndpoint(), undefined, {
			maxReconnectionDelay: 10000,
			minReconnectionDelay: 1000,
			reconnectionDelayGrowFactor: 1.3,
			connectionTimeout: 10000,
			maxRetries: Infinity,
			debug: false,
			startClosed: false,
			WebSocket: GitpodServerWebSocket
		});
		webSocket.onerror = console.error;
		doListen({
			webSocket,
			onConnection: connection => factory.listen(connection),
			logger: new ConsoleLogger()
		});
		return webSocket;
	})();

	const pendingGetOwner = gitpodService.server.getLoggedInUser();
	const pendingGetUser = (async () => {
		return pendingGetOwner;
	})();
	const pendingInstanceListener = gitpodService.listenToInstance(workspaceId);
	const pendingWorkspaceOwned = (async () => {
		const owner = await pendingGetOwner;
		const user = await pendingGetUser;
		const workspaceOwned = owner.id === user.id;
		return workspaceOwned;
	})();

	return new GitpodExtensionContext(
		devMode,
		supervisor,
		gitpodService,
		pendingWebSocket,
		pendingWillCloseSocket,
		workspaceInfo,
		pendingGetOwner,
		pendingGetUser,
		pendingInstanceListener,
		pendingWorkspaceOwned
	);
}

async function main() {
	const context = await createGitpodExtensionContext();
	console.log(`URL: ${context!.workspaceContextUrl}`);
//	const owner = JSON.stringify(await context!.owner);
//	console.log(`Owner: ${owner}`);
	const workspaceid = context!.info.getWorkspaceId();
	const instanceid = context!.info.getInstanceId();
	console.log(`WorkspaceID: ${workspaceid}`);
	console.log(`InstanceID: ${instanceid}`);
//	const info = JSON.stringify(context!.info);
//	console.log(`Info: ${info}`);

/*	console.log(`Listing all WS of user:`);
	const allws = await context!.gitpod.server.getWorkspaces({});
	for (var ws of allws) {
		ws.latestInstance?.id
		console.log(`ID: ${ws.latestInstance?.id}`);
	}*/

	console.log(`Sending heartbeat for ${instanceid}...`);
	await context?.gitpod.server.sendHeartBeat({instanceId: instanceid});
	console.log(`Done`);

	process.exit(0);
}

main();