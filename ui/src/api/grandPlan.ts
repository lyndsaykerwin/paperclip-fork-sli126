import type { GrandPlanView } from "@paperclipai/shared";
import { api } from "./client";

export const grandPlanApi = {
  view: (companyId: string) =>
    api.get<GrandPlanView>(`/companies/${companyId}/grand-plan/view`),
};
