import {
  ConvertibleStatusEnum,
  OptionStatusEnum,
  SafeStatusEnum,
} from "@prisma/client";
import { db } from "./db";

export type OwnershipSlice = {
  key: string;
  value: number; // percentage on a fully-diluted basis
};

export type ShareClassSummary = {
  id: string;
  name: string;
  authorized: number;
  diluted: number;
  ownership: number; // percentage on a fully-diluted basis
  raised: number;
};

export type OverviewData = {
  amountRaised: number;
  fullyDilutedShares: number;
  stakeholderCount: number;
  ownershipByStakeholder: OwnershipSlice[];
  ownershipByShareClass: OwnershipSlice[];
  summary: ShareClassSummary[];
  totalRaised: number;
  isEmpty: boolean;
};

// Cap the number of donut slices; the long tail is grouped into "Others"
const MAX_STAKEHOLDER_SLICES = 6;

const toPercent = (quantity: number, total: number) =>
  total > 0 ? Math.round((quantity / total) * 10000) / 100 : 0;

export const getOverviewData = async (
  companyId: string,
): Promise<OverviewData> => {
  const [
    shareClasses,
    shares,
    options,
    equityPlans,
    safeCapital,
    noteCapital,
    stakeholderCount,
  ] = await Promise.all([
    db.shareClass.findMany({
      where: { companyId },
      select: { id: true, name: true, initialSharesAuthorized: true },
      orderBy: { idx: "asc" },
    }),
    db.share.findMany({
      where: { companyId },
      select: {
        quantity: true,
        capitalContribution: true,
        shareClassId: true,
        stakeholder: { select: { id: true, name: true } },
      },
    }),
    db.option.findMany({
      where: {
        companyId,
        status: {
          notIn: [OptionStatusEnum.CANCELLED, OptionStatusEnum.EXPIRED],
        },
      },
      select: {
        quantity: true,
        equityPlanId: true,
        stakeholder: { select: { id: true, name: true } },
      },
    }),
    db.equityPlan.findMany({
      where: { companyId },
      select: { id: true, initialSharesReserved: true },
    }),
    db.safe.aggregate({
      where: {
        companyId,
        status: { notIn: [SafeStatusEnum.CANCELLED, SafeStatusEnum.EXPIRED] },
      },
      _sum: { capital: true },
    }),
    db.convertibleNote.aggregate({
      where: {
        companyId,
        status: {
          notIn: [
            ConvertibleStatusEnum.CANCELLED,
            ConvertibleStatusEnum.EXPIRED,
          ],
        },
      },
      _sum: { capital: true },
    }),
    db.stakeholder.count({ where: { companyId } }),
  ]);

  const issuedByClass = new Map<string, number>();
  const raisedByClass = new Map<string, number>();
  const grantedByPlan = new Map<string, number>();
  const holdingsByStakeholder = new Map<
    string,
    { name: string; quantity: number }
  >();

  let issuedShares = 0;
  let sharesCapital = 0;

  for (const share of shares) {
    const raised = share.capitalContribution ?? 0;
    issuedShares += share.quantity;
    sharesCapital += raised;

    issuedByClass.set(
      share.shareClassId,
      (issuedByClass.get(share.shareClassId) ?? 0) + share.quantity,
    );
    raisedByClass.set(
      share.shareClassId,
      (raisedByClass.get(share.shareClassId) ?? 0) + raised,
    );

    const holding = holdingsByStakeholder.get(share.stakeholder.id) ?? {
      name: share.stakeholder.name,
      quantity: 0,
    };
    holding.quantity += share.quantity;
    holdingsByStakeholder.set(share.stakeholder.id, holding);
  }

  let grantedOptions = 0;

  for (const option of options) {
    grantedOptions += option.quantity;

    grantedByPlan.set(
      option.equityPlanId,
      (grantedByPlan.get(option.equityPlanId) ?? 0) + option.quantity,
    );

    const holding = holdingsByStakeholder.get(option.stakeholder.id) ?? {
      name: option.stakeholder.name,
      quantity: 0,
    };
    holding.quantity += option.quantity;
    holdingsByStakeholder.set(option.stakeholder.id, holding);
  }

  // Shares reserved for equity plans but not granted as options yet
  let poolReserved = 0;
  let poolAvailable = 0;

  for (const plan of equityPlans) {
    const reserved = Number(plan.initialSharesReserved);
    poolReserved += reserved;
    poolAvailable += Math.max(0, reserved - (grantedByPlan.get(plan.id) ?? 0));
  }

  const fullyDilutedShares = issuedShares + grantedOptions + poolAvailable;
  const amountRaised =
    sharesCapital +
    (safeCapital._sum.capital ?? 0) +
    (noteCapital._sum.capital ?? 0);

  const holders = Array.from(holdingsByStakeholder.values())
    .filter((holder) => holder.quantity > 0)
    .sort((a, b) => b.quantity - a.quantity);

  const ownershipByStakeholder: OwnershipSlice[] = holders
    .slice(0, MAX_STAKEHOLDER_SLICES)
    .map((holder) => ({
      key: holder.name,
      value: toPercent(holder.quantity, fullyDilutedShares),
    }));

  const othersQuantity = holders
    .slice(MAX_STAKEHOLDER_SLICES)
    .reduce((sum, holder) => sum + holder.quantity, 0);

  if (othersQuantity > 0) {
    ownershipByStakeholder.push({
      key: "Others",
      value: toPercent(othersQuantity, fullyDilutedShares),
    });
  }

  if (poolAvailable > 0) {
    ownershipByStakeholder.push({
      key: "Equity plan",
      value: toPercent(poolAvailable, fullyDilutedShares),
    });
  }

  const ownershipByShareClass: OwnershipSlice[] = shareClasses
    .map((shareClass) => ({
      key: shareClass.name,
      value: toPercent(
        issuedByClass.get(shareClass.id) ?? 0,
        fullyDilutedShares,
      ),
    }))
    .filter((slice) => slice.value > 0);

  const stockPlanShares = grantedOptions + poolAvailable;

  if (stockPlanShares > 0) {
    ownershipByShareClass.push({
      key: "Stock plan",
      value: toPercent(stockPlanShares, fullyDilutedShares),
    });
  }

  const summary: ShareClassSummary[] = shareClasses.map((shareClass) => {
    const diluted = issuedByClass.get(shareClass.id) ?? 0;

    return {
      id: shareClass.id,
      name: shareClass.name,
      authorized: Number(shareClass.initialSharesAuthorized),
      diluted,
      ownership: toPercent(diluted, fullyDilutedShares),
      raised: raisedByClass.get(shareClass.id) ?? 0,
    };
  });

  if (stockPlanShares > 0) {
    summary.push({
      id: "stock-plan",
      name: "Stock plan",
      authorized: poolReserved,
      diluted: stockPlanShares,
      ownership: toPercent(stockPlanShares, fullyDilutedShares),
      raised: 0,
    });
  }

  const totalRaised = summary.reduce((sum, row) => sum + row.raised, 0);

  // No equity issued, reserved or raised yet — nothing meaningful to chart
  const isEmpty = fullyDilutedShares === 0 && amountRaised === 0;

  return {
    amountRaised,
    fullyDilutedShares,
    stakeholderCount,
    ownershipByStakeholder,
    ownershipByShareClass,
    summary,
    totalRaised,
    isEmpty,
  };
};
