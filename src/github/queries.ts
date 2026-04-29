import type { graphql as GraphQL } from "@octokit/graphql/types";

import type {
  FieldValue,
  IssueComment,
  IssueSnapshot,
  ProjectItem,
  ProjectSnapshot,
} from "./types.ts";

const PROJECT_QUERY = /* GraphQL */ `
	query ProjectSnapshot(
		$owner: String!
		$number: Int!
		$itemsCursor: String
		$isOrg: Boolean!
		$isUser: Boolean!
	) {
		# We can't parameterize "organization" vs "user" in a single query,
		# so we ask for both and use whichever the caller actually populated.
		# This is a common GitHub-API workaround.
		organization: organization(login: $owner) @include(if: $isOrg) {
			projectV2(number: $number) {
				...ProjectFields
			}
		}
		user: user(login: $owner) @include(if: $isUser) {
			projectV2(number: $number) {
				...ProjectFields
			}
		}
	}

	fragment ProjectFields on ProjectV2 {
		id
		title
		number
		url
		fields(first: 50) {
			nodes {
				... on ProjectV2FieldCommon {
					name
					dataType
				}
			}
		}
		items(first: 100, after: $itemsCursor) {
			pageInfo {
				hasNextPage
				endCursor
			}
			nodes {
				id
				type
				content {
					__typename
					... on Issue {
						number
						title
						url
						state
						createdAt
						updatedAt
						closedAt
						repository {
							nameWithOwner
						}
						assignees(first: 20) {
							nodes {
								login
							}
						}
						labels(first: 50) {
							nodes {
								name
							}
						}
						milestone {
							title
						}
						issueType {
							name
						}
						parent {
							url
						}
						blockedBy(first: 50) {
							nodes {
								url
							}
						}
						blocking(first: 50) {
							nodes {
								url
							}
						}
						issueFieldValues(first: 50) {
							nodes {
								__typename
								... on IssueFieldTextValue {
									value
									field {
										... on IssueFieldText { name }
									}
								}
								... on IssueFieldNumberValue {
									value
									field {
										... on IssueFieldNumber { name }
									}
								}
								... on IssueFieldDateValue {
									value
									field {
										... on IssueFieldDate { name }
									}
								}
								... on IssueFieldSingleSelectValue {
									value
									field {
										... on IssueFieldSingleSelect { name }
									}
								}
							}
						}
					}
				}
				fieldValues(first: 50) {
					nodes {
						__typename
						... on ProjectV2ItemFieldTextValue {
							text
							field {
								... on ProjectV2FieldCommon {
									name
								}
							}
						}
						... on ProjectV2ItemFieldNumberValue {
							number
							field {
								... on ProjectV2FieldCommon {
									name
								}
							}
						}
						... on ProjectV2ItemFieldDateValue {
							date
							field {
								... on ProjectV2FieldCommon {
									name
								}
							}
						}
						... on ProjectV2ItemFieldSingleSelectValue {
							name
							field {
								... on ProjectV2FieldCommon {
									name
								}
							}
						}
						... on ProjectV2ItemFieldIterationValue {
							title
							startDate
							field {
								... on ProjectV2FieldCommon {
									name
								}
							}
						}
					}
				}
			}
		}
	}
`;

// The GraphQL response shapes — narrow types just for parsing, kept private
// to this module. We map them into our domain types before exporting.

interface RawFieldValue {
  __typename: string;
  text?: string;
  number?: number;
  date?: string;
  name?: string;
  title?: string;
  startDate?: string;
  field?: { name?: string };
}

interface RawProjectItem {
  id: string;
  type: "ISSUE" | "PULL_REQUEST" | "DRAFT_ISSUE" | "REDACTED";
  content: {
    __typename: string;
    number?: number;
    title?: string;
    url?: string;
    state?: string;
    createdAt?: string;
    updatedAt?: string;
    closedAt?: string | null;
    repository?: { nameWithOwner: string };
    assignees?: { nodes: Array<{ login: string }> };
    labels?: { nodes: Array<{ name: string }> };
    milestone?: { title: string } | null;
    issueType?: { name: string } | null;
    parent?: { url: string } | null;
    blockedBy?: { nodes: Array<{ url: string }> };
    blocking?: { nodes: Array<{ url: string }> };
    issueFieldValues?: { nodes: RawIssueFieldValue[] };
  } | null;
  fieldValues: { nodes: RawFieldValue[] };
}

interface RawProjectResponse {
  organization?: { projectV2: RawProject | null } | null;
  user?: { projectV2: RawProject | null } | null;
}

interface RawProject {
  id: string;
  title: string;
  number: number;
  url: string;
  fields: { nodes: Array<{ name?: string; dataType?: string }> };
  items: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawProjectItem[];
  };
}

/**
 * Project field dataTypes whose values we know how to flatten to a primitive.
 * Other dataTypes (ASSIGNEES, LABELS, MILESTONE, REPOSITORY, LINKED_PULL_REQUESTS,
 * REVIEWERS, PARENT_ISSUE, SUB_ISSUES_PROGRESS, TITLE, …) are GitHub's built-in
 * system fields that mirror underlying issue properties — we either surface them
 * via dedicated columns or skip them entirely.
 */
const SUPPORTED_FIELD_TYPES = new Set([
  "TEXT",
  "NUMBER",
  "DATE",
  "SINGLE_SELECT",
  "ITERATION",
]);

/** Pull a primitive value out of a raw field value entry. */
function extractFieldValue(
  raw: RawFieldValue,
): [name: string, value: FieldValue] | null {
  const name = raw.field?.name;
  if (!name) return null;

  switch (raw.__typename) {
    case "ProjectV2ItemFieldTextValue":
      return [name, raw.text ?? null];
    case "ProjectV2ItemFieldNumberValue":
      return [name, raw.number ?? null];
    case "ProjectV2ItemFieldDateValue":
      return [name, raw.date ?? null];
    case "ProjectV2ItemFieldSingleSelectValue":
      return [name, raw.name ?? null];
    case "ProjectV2ItemFieldIterationValue":
      // Render iterations as "Sprint 4 (2026-04-15)" or similar.
      return [
        name,
        raw.title ? `${raw.title} (${raw.startDate ?? "?"})` : null,
      ];
    default:
      return null;
  }
}

/** Map a raw API item to our domain type. Returns null for non-issues. */
function toProjectItem(raw: RawProjectItem): ProjectItem | null {
  if (raw.type !== "ISSUE" || !raw.content) return null;

  const fields: Record<string, FieldValue> = {};
  // Issue fields first; project fields take precedence on name collisions.
  for (const rawValue of raw.content.issueFieldValues?.nodes ?? []) {
    const entry = extractIssueFieldValue(rawValue);
    if (entry) fields[entry[0]] = entry[1];
  }
  for (const rawValue of raw.fieldValues.nodes) {
    const entry = extractFieldValue(rawValue);
    if (entry) fields[entry[0]] = entry[1];
  }

  return {
    id: raw.id,
    contentType: "Issue",
    number: raw.content.number ?? null,
    title: raw.content.title ?? "",
    url: raw.content.url ?? null,
    state: raw.content.state ?? null,
    repository: raw.content.repository?.nameWithOwner ?? null,
    assignees: raw.content.assignees?.nodes.map((n) => n.login) ?? [],
    labels: raw.content.labels?.nodes.map((n) => n.name) ?? [],
    milestone: raw.content.milestone?.title ?? null,
    issueType: raw.content.issueType?.name ?? null,
    parentIssue: raw.content.parent?.url ?? null,
    blockedBy: raw.content.blockedBy?.nodes.map((n) => n.url) ?? [],
    blocking: raw.content.blocking?.nodes.map((n) => n.url) ?? [],
    createdAt: raw.content.createdAt ?? "",
    updatedAt: raw.content.updatedAt ?? "",
    closedAt: raw.content.closedAt ?? null,
    fields,
  };
}

/** Fetch a complete project snapshot, paginating through all items. */
export async function fetchProject(
  client: GraphQL,
  ownerType: "orgs" | "users",
  owner: string,
  number: number,
): Promise<ProjectSnapshot | null> {
  const isOrg = ownerType === "orgs";
  const items: ProjectItem[] = [];
  const fieldNames = new Set<string>();
  let projectMeta: {
    id: string;
    title: string;
    number: number;
    url: string;
  } | null = null;
  let cursor: string | null = null;

  do {
    const data: RawProjectResponse = await client(PROJECT_QUERY, {
      owner,
      number,
      itemsCursor: cursor,
      isOrg,
      isUser: !isOrg,
    });

    const project =
      data.organization?.projectV2 ?? data.user?.projectV2 ?? null;
    if (!project) return null;

    projectMeta ??= {
      id: project.id,
      title: project.title,
      number: project.number,
      url: project.url,
    };

    for (const node of project.fields.nodes) {
      if (
        node.name &&
        node.dataType &&
        SUPPORTED_FIELD_TYPES.has(node.dataType)
      ) {
        fieldNames.add(node.name);
      }
    }

    for (const rawItem of project.items.nodes) {
      for (const node of rawItem.content?.issueFieldValues?.nodes ?? []) {
        if (node.field?.name) fieldNames.add(node.field.name);
      }
      const item = toProjectItem(rawItem);
      if (item) items.push(item);
    }

    cursor = project.items.pageInfo.hasNextPage
      ? project.items.pageInfo.endCursor
      : null;
  } while (cursor);

  // projectMeta is guaranteed set because the loop always runs at least once
  // and would have returned null if the project didn't exist.
  if (!projectMeta) return null;

  return {
    ...projectMeta,
    fieldNames: [...fieldNames],
    items,
  };
}

const ISSUE_QUERY = /* GraphQL */ `
	query IssueSnapshot(
		$owner: String!
		$repo: String!
		$number: Int!
		$commentsCursor: String
	) {
		repository(owner: $owner, name: $repo) {
			issue(number: $number) {
				number
				title
				url
				state
				body
				createdAt
				updatedAt
				closedAt
				author {
					login
				}
				assignees(first: 20) {
					nodes {
						login
					}
				}
				labels(first: 50) {
					nodes {
						name
					}
				}
				milestone {
					title
				}
				issueType {
					name
				}
				parent {
					url
				}
				blockedBy(first: 50) {
					nodes {
						url
						number
						title
						state
						repository {
							nameWithOwner
						}
					}
				}
				blocking(first: 50) {
					nodes {
						url
						number
						title
						state
						repository {
							nameWithOwner
						}
					}
				}
				issueFieldValues(first: 50) {
					nodes {
						__typename
						... on IssueFieldTextValue {
							value
							field {
								... on IssueFieldText { name }
							}
						}
						... on IssueFieldNumberValue {
							value
							field {
								... on IssueFieldNumber { name }
							}
						}
						... on IssueFieldDateValue {
							value
							field {
								... on IssueFieldDate { name }
							}
						}
						... on IssueFieldSingleSelectValue {
							value
							field {
								... on IssueFieldSingleSelect { name }
							}
						}
					}
				}
				comments(first: 100, after: $commentsCursor) {
					pageInfo {
						hasNextPage
						endCursor
					}
					nodes {
						body
						createdAt
						author {
							login
						}
					}
				}
			}
		}
	}
`;

interface RawIssueFieldValue {
  __typename: string;
  value?: string | number;
  field?: { name?: string };
}

interface RawDependencyRef {
  url: string;
  number: number;
  title: string;
  state: string;
  repository: { nameWithOwner: string };
}

interface RawIssueResponse {
  repository: {
    issue: {
      number: number;
      title: string;
      url: string;
      state: string;
      body: string;
      createdAt: string;
      updatedAt: string;
      closedAt: string | null;
      author: { login: string } | null;
      assignees: { nodes: Array<{ login: string }> };
      labels: { nodes: Array<{ name: string }> };
      milestone: { title: string } | null;
      issueType: { name: string } | null;
      parent: { url: string } | null;
      blockedBy: { nodes: RawDependencyRef[] };
      blocking: { nodes: RawDependencyRef[] };
      issueFieldValues: { nodes: RawIssueFieldValue[] };
      comments: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          body: string;
          createdAt: string;
          author: { login: string } | null;
        }>;
      };
    } | null;
  } | null;
}

/** Map a raw dependency reference to a domain IssueDependency. */
function toDependencyRef(raw: RawDependencyRef) {
  return {
    url: raw.url,
    number: raw.number,
    title: raw.title,
    state: raw.state,
    repository: raw.repository.nameWithOwner,
  };
}

/** Pull a primitive value out of a raw issue field value entry. */
function extractIssueFieldValue(
  raw: RawIssueFieldValue,
): [name: string, value: FieldValue] | null {
  const name = raw.field?.name;
  if (!name) return null;
  return [name, raw.value ?? null];
}

type RawIssue = NonNullable<
  NonNullable<RawIssueResponse["repository"]>["issue"]
>;

/** Fetch a single issue with all comments (paginated). */
export async function fetchIssue(
  client: GraphQL,
  owner: string,
  repo: string,
  number: number,
): Promise<IssueSnapshot | null> {
  const comments: IssueComment[] = [];
  let issueMeta: RawIssue | null = null;
  let cursor: string | null = null;

  do {
    const data: RawIssueResponse = await client(ISSUE_QUERY, {
      owner,
      repo,
      number,
      commentsCursor: cursor,
    });

    const issue = data.repository?.issue;
    if (!issue) return null;
    issueMeta ??= issue;

    for (const c of issue.comments.nodes) {
      comments.push({
        author: c.author?.login ?? null,
        createdAt: c.createdAt,
        bodyMarkdown: c.body,
      });
    }

    cursor = issue.comments.pageInfo.hasNextPage
      ? issue.comments.pageInfo.endCursor
      : null;
  } while (cursor);

  if (!issueMeta) return null;

  const fields: Record<string, FieldValue> = {};
  for (const raw of issueMeta.issueFieldValues.nodes) {
    const entry = extractIssueFieldValue(raw);
    if (entry) fields[entry[0]] = entry[1];
  }

  return {
    owner,
    repo,
    number: issueMeta.number,
    title: issueMeta.title,
    url: issueMeta.url,
    state: issueMeta.state,
    author: issueMeta.author?.login ?? null,
    createdAt: issueMeta.createdAt,
    updatedAt: issueMeta.updatedAt,
    closedAt: issueMeta.closedAt,
    assignees: issueMeta.assignees.nodes.map((n) => n.login),
    labels: issueMeta.labels.nodes.map((n) => n.name),
    milestone: issueMeta.milestone?.title ?? null,
    issueType: issueMeta.issueType?.name ?? null,
    parentIssue: issueMeta.parent?.url ?? null,
    blockedBy: issueMeta.blockedBy.nodes.map(toDependencyRef),
    blocking: issueMeta.blocking.nodes.map(toDependencyRef),
    bodyMarkdown: issueMeta.body,
    fields,
    comments,
  };
}
