import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { getAgents } from '@main/core/agents/getAgents';
import { getLocations, getLocationById } from '@main/core/locations/store';
import { generateTraceMindAIResponse } from '../ai/gateway';
import { redactOutboundText } from '../ai/redaction';
import { createIssue } from '../investigation/issue-store';
import { getBoundBrainPolicy } from './binding';
import { getLocalBrainContext } from './local-context';
import { isBrainPath } from './policy';
import { answerBrainContext } from './service';

const requestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('context'),
    roomId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512),
    task: z.string().min(1).max(8000),
  }),
  z.strictObject({
    type: z.literal('report'),
    roomId: z.string().min(1).max(512),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(8000),
    paths: z.array(z.string().refine(isBrainPath)).min(1).max(12),
  }),
]);
export type BrainBridgeRequest = z.infer<typeof requestSchema>;

/** Called only from the authenticated, same-room session IPC answerer. No caller-supplied project ID. */
export async function handleSwitchBrain(input: {
  agentId: string;
  cwd: string;
  request: BrainBridgeRequest;
}): Promise<{ context: string; alert: string | null } | null> {
  const request = requestSchema.parse(input.request);
  const candidates = (await getAgents()).filter((agent) => agent.switchAgentId === input.agentId);
  // Ambiguity is not resolved by picking a convenient project or a same-named agent.
  if (candidates.length !== 1) return null;
  const agent = candidates[0]!;
  const location = await getLocationById(agent.locationId);
  if (
    !location ||
    location.sshHost !== null ||
    (await realpath(location.dir)) !== (await realpath(input.cwd))
  )
    return null;
  return handleProjectBrain(location.id, request);
}

async function handleProjectBrain(projectId: string, request: BrainBridgeRequest) {
  const policy = await getBoundBrainPolicy(projectId);
  if (!policy?.bridgeEnabled) return null;
  if (request.type === 'context') {
    const result = await answerBrainContext(projectId, request.task, policy, {
      retrieve: getLocalBrainContext,
      generate: generateTraceMindAIResponse,
    });
    const current = await getBoundBrainPolicy(projectId);
    if (!current?.bridgeEnabled || JSON.stringify(current) !== JSON.stringify(policy))
      throw new Error('Project brain settings changed during retrieval.');
    return { context: JSON.stringify(result), alert: null };
  }
  if (request.paths.some((path) => !policy.allowedPaths.includes(path)))
    throw new Error('Report path is not approved for this project.');
  const context = await getLocalBrainContext(
    projectId,
    request.paths.join(' '),
    policy.allowedPaths
  );
  if (request.paths.some((path) => !context.files.some((file) => file.path === path)))
    throw new Error('Report path is absent from this project graph.');
  const issue = await createIssue(projectId, {
    title: redactOutboundText(request.title),
    description: `${redactOutboundText(request.description)}\n\nAgent-reported, unverified finding. Indexed paths: ${request.paths.join(', ')}.`,
    auditId: context.revision?.startsWith('audit:') ? context.revision.slice(6) : null,
  });
  return {
    context: JSON.stringify({ issueId: issue.id, status: 'recorded-locally', verified: false }),
    // Never send task text, notes, paths, source, or model-generated prose into the communication platform.
    alert: `TraceMind recorded agent-reported issue ${issue.id} locally. Verification is pending. Open this project's Issues section to review its evidence.`,
  };
}

/** Private parent IPC only. The controller supplies cwd from its saved agent configuration,
 * not task text. Root equality and the native project grant are both required. */
export async function handleManagedSwitchBrain(input: {agentId: string; cwd: string; request: BrainBridgeRequest}) {
  const request = requestSchema.parse(input.request);
  const root = await realpath(input.cwd);
  const candidates = [];
  for (const location of await getLocations()) {
    if (location.sshHost !== null) continue;
    try { if (await realpath(location.dir) === root) candidates.push(location); } catch { /* Unavailable registered project. */ }
  }
  if (candidates.length !== 1) return null;
  return handleProjectBrain(candidates[0]!.id, request);
}
