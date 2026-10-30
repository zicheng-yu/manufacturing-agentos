import type { DB } from '../../db.ts';
import { keywordScore } from '../../core/util.ts';
import { isClosedComplaint, listCases, listComplaints, type Complaint } from './data.ts';
import { normalizeSymptom } from './symptoms.ts';

export function isQualityFollowUp(text: string): boolean {
  const rest = text.replace(/永久对策|临时围堵|围堵|根因|失效分析|验证|下一步|怎么|如何|处理|解决|继续|起草|报告|草案|8D|刚才|上面|这条|那条|这个|那个|现在|应该|需要|可以|我们|先|那|这|它|该|做|要|呢|吗|了|的|再/gi, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return !rest;
}

export function qualityQuery(db: DB, input: string, history: string[]) {
  let text = input;
  if (isQualityFollowUp(input)) text = [...history].reverse().find((question) => !isQualityFollowUp(question)) ?? input;
  const complaintIds: string[] = text.toUpperCase().match(/\bCC-[A-Z0-9-]+\b/g) ?? [];
  const caseIds: string[] = text.toUpperCase().match(/\bQC-[A-Z0-9-]+\b/g) ?? [];
  const complaints = listComplaints(db);
  const cases = listCases(db);
  const missing = [...complaintIds.filter((id) => !complaints.some((c) => c.id === id)), ...caseIds.filter((id) => !cases.some((c) => c.id === id))];
  let complaint: Complaint | undefined;
  let identified = false;
  if (!missing.length && complaintIds.length === 1) {
    complaint = complaints.find((c) => c.id === complaintIds[0]);
    identified = true;
  } else if (!complaintIds.length) {
    const candidates = complaints.filter((c) => !isClosedComplaint(c) && text.includes(c.customer) && keywordScore(normalizeSymptom(text), normalizeSymptom(c.symptom)) >= 4);
    if (candidates.length === 1) complaint = candidates[0];
  }
  return { text, missing, complaintIds, complaint, identified, search: complaint ? complaint.symptom : text };
}
