export type InventoryAdjustResult = {
  operationId: string;
};

export type InventoryAdjustInput = {
  inventoryItemId: string;
  fromLocationId: string;
  toLocationId: string;
  delta: number;
  reason?: string;
};

export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/**
 * Derive a concrete transfer plan from an alert's evidence, or null when the
 * evidence lacks one (no inventory item, no source/destination location, or
 * no usable delta). Shared by the embedded-app and dashboard alert action
 * routes so both surfaces accept exactly the same evidence shape.
 */
export function transferPlanFromEvidence(
  evidence: Record<string, unknown>,
): InventoryAdjustInput | null {
  const str = (v: unknown): string =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  const inventoryItemId = str(evidence.inventory_item_id);
  const fromLocationId = str(evidence.from_location_id);
  const toLocationId = str(evidence.to_location_id);
  const delta = Number(evidence.recommended_delta ?? evidence.delta ?? 0);
  if (!inventoryItemId || !fromLocationId || !toLocationId || !delta) return null;
  return { inventoryItemId, fromLocationId, toLocationId, delta };
}

const MUTATION = /* GraphQL */ `
  mutation calderynInventoryAdjust($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export async function inventoryAdjustQuantities(
  admin: AdminGraphqlClient,
  input: InventoryAdjustInput,
): Promise<InventoryAdjustResult> {
  const delta = Math.trunc(input.delta);
  if (delta === 0) {
    throw new Error("inventoryAdjustQuantities called with delta=0");
  }

  const variables = {
    input: {
      reason: input.reason ?? "correction",
      name: "available",
      referenceDocumentUri: `calderyn://reallocate/${Date.now()}`,
      changes: [
        {
          inventoryItemId: input.inventoryItemId,
          locationId: input.fromLocationId,
          delta: -Math.abs(delta),
        },
        {
          inventoryItemId: input.inventoryItemId,
          locationId: input.toLocationId,
          delta: Math.abs(delta),
        },
      ],
    },
  };

  const response = await admin.graphql(MUTATION, { variables });
  const body = (await response.json()) as {
    data?: {
      inventoryAdjustQuantities?: {
        inventoryAdjustmentGroup?: { id: string } | null;
        userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  const payload = body.data?.inventoryAdjustQuantities;
  if (payload?.userErrors?.length) {
    throw new Error(
      payload.userErrors.map((e) => `${e.code ?? "ERR"}: ${e.message}`).join("; "),
    );
  }
  const id = payload?.inventoryAdjustmentGroup?.id;
  if (!id) {
    throw new Error("inventoryAdjustQuantities returned no inventoryAdjustmentGroup");
  }
  return { operationId: id };
}
