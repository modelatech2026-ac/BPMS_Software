/**
 * ProductionPulse BPMS - Clean Slate Data Store
 * All legacy mock data, sample projects, mock employees, and historical logs have been purged.
 * Initialized clean for dynamic user data entry.
 */

import { Employee, BimProject, DailyWorkLog } from '../types';

export const INITIAL_EMPLOYEES: Employee[] = [];

export const INITIAL_PROJECTS: BimProject[] = [];

export const generateInitialWorkLogs = (): DailyWorkLog[] => [];
