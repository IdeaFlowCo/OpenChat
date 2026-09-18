#!/usr/bin/env node

/**
 * Guarded administrative pre-link for existing OpenChat/Noos users.
 *
 * The manifest is read from stdin and must contain authoritative IDs from both
 * stores. Email is a verification guard, never the durable identity key.
 * Nothing is written unless --apply is present.
 *
 * Example:
 *   node scripts/link-ideaflow-identities.mjs --stdin < links.json
 *   node scripts/link-ideaflow-identities.mjs --stdin --apply < links.json
 */
import process from 'node:process';
import neo4j from 'neo4j-driver';

const IDEAFLOW_ISSUER = 'https://id.ideaflow.app/api/auth';
const APPLY = process.argv.includes('--apply');

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/link-ideaflow-identities.mjs --stdin [--apply]');
  process.exit(0);
}

if (!process.argv.includes('--stdin')) {
  throw new Error('Refusing to run without --stdin; manifests must not be committed');
}

const manifest = validateManifest(JSON.parse(await readStdin()))
  .sort((left, right) => left.localUserId.localeCompare(right.localUserId));
const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://noos_neo4j:7687',
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || ''),
);

try {
  await driver.verifyConnectivity();
  const session = driver.session();
  try {
    // A write transaction is used in dry-run mode too because inspectLink
    // briefly SETs/REMOVEs a private property to acquire the same node lock as
    // the live linking path. The dry run has no net persistent writes.
    const results = await session.executeWrite(async (tx) => {
      const output = [];
      for (const link of manifest) {
        const existing = await inspectLink(tx, link);
        if (existing.status === 'ready' && APPLY) {
          await applyLink(tx, link);
          output.push({ ...publicLink(link), status: 'linked' });
        } else {
          output.push({ ...publicLink(link), status: existing.status });
        }
      }
      return output;
    });

    console.log(JSON.stringify({
      mode: APPLY ? 'apply' : 'dry-run',
      count: results.length,
      linked: results.filter((result) => result.status === 'linked').length,
      ready: results.filter((result) => result.status === 'ready').length,
      alreadyLinked: results.filter((result) => result.status === 'already_linked').length,
      results,
    }, null, 2));
  } finally {
    await session.close();
  }
} finally {
  await driver.close();
}

function validateManifest(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Manifest must be a non-empty JSON array');
  }
  if (value.length > 1000) {
    throw new Error('Manifest exceeds the 1000-link safety limit');
  }

  const localIds = new Set();
  const identityKeys = new Set();
  return value.map((candidate, index) => {
    const localUserId = requiredString(candidate?.localUserId, `links[${index}].localUserId`);
    const email = requiredString(candidate?.email, `links[${index}].email`).toLowerCase();
    const issuer = requiredString(candidate?.issuer, `links[${index}].issuer`);
    const subject = requiredString(candidate?.subject, `links[${index}].subject`);

    if (issuer !== IDEAFLOW_ISSUER) {
      throw new Error(`links[${index}].issuer must be the canonical Ideaflow issuer`);
    }
    if (candidate.centralEmailVerified !== true) {
      throw new Error(`links[${index}] lacks centralEmailVerified=true`);
    }
    if (!email.includes('@')) {
      throw new Error(`links[${index}].email is invalid`);
    }

    const identityKey = `${issuer}\u001f${subject}`;
    if (localIds.has(localUserId)) {
      throw new Error(`Duplicate localUserId in manifest at index ${index}`);
    }
    if (identityKeys.has(identityKey)) {
      throw new Error(`Duplicate issuer/subject in manifest at index ${index}`);
    }
    localIds.add(localUserId);
    identityKeys.add(identityKey);

    return {
      manifestIndex: index,
      localUserId,
      email,
      issuer,
      subject,
      identityKey,
      linkedAt: new Date().toISOString(),
    };
  });
}

async function inspectLink(tx, link) {
  // Lock the target before reading its mapping. Neo4j's read-committed
  // isolation otherwise permits two different subjects to pass the read and
  // overwrite one another. Sorting the manifest by localUserId also keeps the
  // multi-row lock order deterministic.
  const result = await tx.run(`
    MATCH (u:User {id: $localUserId})
    WHERE toLower(u.email) = $email
    SET u._ideaflowBindingLock = true
    REMOVE u._ideaflowBindingLock
    RETURN u.ideaflowIssuer AS issuer,
           u.ideaflowSub AS subject,
           u.ideaflowIdentityKey AS identityKey
  `, link);

  if (result.records.length !== 1) {
    throw new Error(`No unique local user/email match for link[${link.manifestIndex}]`);
  }

  const record = result.records[0];
  const conflicts = await tx.run(`
    MATCH (other:User)
    WHERE other.id <> $localUserId AND (
      other.ideaflowIdentityKey = $identityKey OR
      (other.ideaflowSub = $subject
       AND (other.ideaflowIssuer IS NULL OR other.ideaflowIssuer = $issuer))
    )
    RETURN other.id AS id
    LIMIT 1
  `, link);
  if (conflicts.records.length > 0) {
    throw new Error('Issuer/subject is already linked to another local user');
  }

  const current = {
    issuer: record.get('issuer'),
    subject: record.get('subject'),
    identityKey: record.get('identityKey'),
  };
  const expected = {
    issuer: link.issuer,
    subject: link.subject,
    identityKey: link.identityKey,
  };
  for (const field of Object.keys(expected)) {
    if (current[field] !== null && current[field] !== expected[field]) {
      throw new Error(`link[${link.manifestIndex}] has a conflicting ${field}`);
    }
  }

  return {
    status: Object.keys(expected).every((field) => current[field] === expected[field])
      ? 'already_linked'
      : 'ready',
  };
}

async function applyLink(tx, link) {
  const result = await tx.run(`
    MATCH (u:User {id: $localUserId})
    WHERE toLower(u.email) = $email
      AND (u.ideaflowIssuer IS NULL OR u.ideaflowIssuer = $issuer)
      AND (u.ideaflowSub IS NULL OR u.ideaflowSub = $subject)
      AND (u.ideaflowIdentityKey IS NULL OR u.ideaflowIdentityKey = $identityKey)
      AND NOT EXISTS {
        MATCH (other:User)
        WHERE other <> u AND (
          other.ideaflowIdentityKey = $identityKey OR
          (other.ideaflowSub = $subject
           AND (other.ideaflowIssuer IS NULL OR other.ideaflowIssuer = $issuer))
        )
      }
    SET u.ideaflowIssuer = $issuer,
        u.ideaflowSub = $subject,
        u.ideaflowIdentityKey = $identityKey,
        u.ideaflowEmail = $email,
        u.ideaflowEmailVerified = true,
        u.ideaflowLinkedAt = datetime($linkedAt)
    RETURN u.id AS id
  `, link);

  if (result.records.length !== 1) {
    throw new Error(`Atomic link preconditions failed for link[${link.manifestIndex}]`);
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function publicLink(link) {
  return { manifestIndex: link.manifestIndex };
}

async function readStdin() {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  if (value.trim() === '') throw new Error('Manifest stdin is empty');
  return value;
}
