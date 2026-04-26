"use client";

import { useState } from "react";

export type PlanId = "api" | "pro" | "max5" | "max20";

export interface Plan {
  id: PlanId;
  label: string;
  monthlyCost: number | null;
  isSubscription: boolean;
}

export const PLANS: Plan[] = [
  { id: "api",   label: "API (Pay-as-you-go)", monthlyCost: null, isSubscription: false },
  { id: "pro",   label: "Pro ($20/mo)",         monthlyCost: 20,   isSubscription: true  },
  { id: "max5",  label: "Max 5x ($100/mo)",     monthlyCost: 100,  isSubscription: true  },
  { id: "max20", label: "Max 20x ($200/mo)",    monthlyCost: 200,  isSubscription: true  },
];

export function usePlan() {
  const [planId, setPlanIdState] = useState<PlanId>(
    () => (typeof window !== "undefined" ? localStorage.getItem("claude-plan") as PlanId : null) ?? "api"
  );

  function setPlanId(id: PlanId) {
    localStorage.setItem("claude-plan", id);
    setPlanIdState(id);
  }

  const plan = PLANS.find((p) => p.id === planId)!;
  return { planId, plan, setPlanId };
}
