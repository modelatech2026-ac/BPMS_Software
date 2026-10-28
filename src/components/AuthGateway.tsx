import React, { useState, useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useBimData } from '../context/BimDataContext';
import {
  Building2,
  ShieldCheck,
  RefreshCw,
  Mail,
  User,
  X,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { TwoFactorChallengeModal } from './TwoFactorChallengeModal';
import { db } from '../firebase/config';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import {
  isSuperAdminEmail,
  normalizeUserRole,
  mapAppRoleToAccessLevel,
  mapAppRoleToDisplayRole,
  mapUserRoleToSecurityRole,
} from '../auth/googleAuth';
import { generateRequestDocId } from '../auth/roleSync';
import { AccessLevel } from '../types';

interface AuthGatewayProps {
  isModal?: boolean;
  onClose?: () => void;
  initialMode?: string;
  onLoginSuccess?: (targetRoute?: string) => void;
  onEnterDashboard?: () => void;
  hasActiveSession?: boolean;
  attemptedRoute?: string | null;
}

interface SubmittedRequestData {
  name: string;
  email: string;
  uid: string;
}

export const AuthGateway: React.FC<AuthGatewayProps> = ({
  isModal = false,
  onClose,
  onLoginSuccess,
  attemptedRoute = null,
}) => {
  const {
    is2FAPending,
    submitAccessRequest,
    updateCurrentUser,
    logout,
  } = useAuth();

  const { currentUser, onboardingRequests, registerAccessRequest, signOut } = useBimData();

  // View state: 'form' | 'pending'
  const [viewStep, setViewStep] = useState<'form' | 'pending'>(() => {
    const rawStatus = (currentUser?.status || '').toLowerCase();
    if (!isModal && currentUser?.email && (rawStatus === 'pending' || rawStatus === 'pending_approval')) {
      return 'pending';
    }
    return 'form';
  });

  // Form Fields matching exact visual design in image.png
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [inputErrors, setInputErrors] = useState<{ name?: string; email?: string }>({});

  const [submittedRecord, setSubmittedRecord] = useState<SubmittedRequestData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Active user reference for real-time pending listener
  const activeUser = submittedRecord || (currentUser?.email ? {
    name: currentUser.name,
    email: currentUser.email,
    uid: currentUser.googleId || currentUser.id || generateRequestDocId(currentUser.email),
  } : null);

  // Real-time Firestore listener when in pending approval step
  useEffect(() => {
    if (viewStep !== 'pending' || !activeUser?.email) return;

    let unsubscribe: (() => void) | undefined;
    try {
      const cleanEmail = activeUser.email.trim().toLowerCase();
      const reqQuery = query(collection(db, 'access_requests'), where('email', '==', cleanEmail));
      unsubscribe = onSnapshot(
        reqQuery,
        (snapshot) => {
          if (!snapshot.empty) {
            const docs = snapshot.docs.map((d) => ({
              id: d.id,
              ...d.data({ serverTimestamps: 'estimate' }),
            } as any));
            docs.sort((a, b) => {
              const aStatus = String(a.status || '').toLowerCase();
              const bStatus = String(b.status || '').toLowerCase();
              const aWeight = aStatus === 'approved' ? 3 : aStatus === 'rejected' ? 2 : 1;
              const bWeight = bStatus === 'approved' ? 3 : bStatus === 'rejected' ? 2 : 1;
              if (aWeight !== bWeight) return bWeight - aWeight;
              const aTime = new Date(a.updatedAt || a.reviewedAt || a.timestamp || 0).getTime() || 0;
              const bTime = new Date(b.updatedAt || b.reviewedAt || b.timestamp || 0).getTime() || 0;
              return bTime - aTime;
            });
            const data = docs[0];
            const firestoreStatus = String(data?.status || '').trim().toLowerCase();
            if (firestoreStatus === 'approved' || firestoreStatus === 'active') {
              const assignedAppRole = normalizeUserRole(
                data?.assignedRole || data?.role || data?.appRole,
                isSuperAdminEmail(cleanEmail)
              );
              const calculatedAccessLevel = (data?.assignedAccessLevel as AccessLevel) || mapAppRoleToAccessLevel(assignedAppRole);
              const displayRole = mapAppRoleToDisplayRole(assignedAppRole);
              const securityRole = mapUserRoleToSecurityRole(assignedAppRole);

              updateCurrentUser({
                id: data?.id || activeUser.uid,
                googleId: data?.uid || data?.id || activeUser.uid,
                email: cleanEmail,
                status: 'APPROVED',
                appRole: assignedAppRole,
                accessLevel: calculatedAccessLevel,
                role: displayRole,
                securityRole,
                isAdmin: assignedAppRole === 'SUPER_ADMIN' || assignedAppRole === 'DIRECTOR' || assignedAppRole === 'PROJECT_MANAGER',
                name: data?.fullName || data?.name || activeUser.name,
              });
              const target =
                assignedAppRole === 'VIEWER'
                  ? '/daily-tracker'
                  : attemptedRoute || '/dashboard';
              if (onLoginSuccess) {
                onLoginSuccess(target);
              } else if (onClose) {
                onClose();
              }
            }
          }
        },
        (err) => {
          console.warn('Real-time access request listener notice:', err);
        }
      );
    } catch (err) {
      console.warn('Error establishing Firestore listener:', err);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [viewStep, activeUser?.email, activeUser?.uid, activeUser?.name, updateCurrentUser, onLoginSuccess, attemptedRoute, onClose]);

  // If 2FA challenge is currently pending, show 2FA challenge modal
  if (is2FAPending) {
    return (
      <TwoFactorChallengeModal
        onSuccess={() => {
          if (onLoginSuccess) {
            onLoginSuccess(attemptedRoute || '/dashboard');
          } else if (onClose) {
            onClose();
          }
        }}
        onCancel={() => {
          setErrorMessage(null);
        }}
        isStandaloneScreen={!isModal}
      />
    );
  }

  const isValidEmail = (str: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim());

  /**
   * Handle Submit Request
   */
  const handleSubmitRequest = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const cleanName = fullName.trim();
    const cleanEmail = email.trim().toLowerCase();

    const errors: { name?: string; email?: string } = {};
    if (!cleanName) {
      errors.name = 'Please enter your Full Name.';
    } else if (cleanName.length < 2) {
      errors.name = 'Full Name must be at least 2 characters.';
    }

    if (!cleanEmail) {
      errors.email = 'Please enter your email address.';
    } else if (!isValidEmail(cleanEmail)) {
      errors.email = 'Please provide a valid email format (e.g. name@example.com).';
    }

    if (Object.keys(errors).length > 0) {
      setInputErrors(errors);
      return;
    }

    setInputErrors({});
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const generatedUid = generateRequestDocId(cleanEmail);
    const isoTimestamp = new Date().toISOString();
    const userDiscipline = 'BIM - ACS';
    const userReason = 'Sign-in Access Request for ProductionPulse BPMS';

    try {
      // 1. Super Admin fast-path sign-in
      if (isSuperAdminEmail(cleanEmail)) {
        const result = await submitAccessRequest({
          name: cleanName,
          email: cleanEmail,
          uid: generatedUid,
        });
        const targetRoute =
          result.user?.appRole === 'VIEWER'
            ? '/daily-tracker'
            : attemptedRoute || '/dashboard';
        if (onLoginSuccess) {
          onLoginSuccess(targetRoute);
        } else if (onClose) {
          onClose();
        }
        return;
      }

      // 2. Write new pending access request directly to Firestore collection(db, "access_requests")
      const requestPayload = {
        fullName: cleanName,
        name: cleanName,
        email: cleanEmail,
        status: 'pending',
        createdAt: serverTimestamp(),
        requestedAt: isoTimestamp,
        timestamp: isoTimestamp,
        requestTimestamp: isoTimestamp,
        updatedAt: isoTimestamp,
        requestedRole: 'Editor',
        role: 'Editor',
        assignedRole: 'EDITOR',
        assignedAccessLevel: 'Editor',
        discipline: userDiscipline,
        primaryDiscipline: userDiscipline,
        organization: userDiscipline,
        reasonForAccess: userReason,
        accessReason: userReason,
        notes: userReason,
      };

      let finalDocId = generatedUid;

      // Execute addDoc to collection(db, "access_requests")
      const writePromise = addDoc(collection(db, 'access_requests'), requestPayload);
      const docRef = await Promise.race([
        writePromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);

      if (docRef && docRef.id) {
        finalDocId = docRef.id;
      } else {
        // Fallback deterministic write if addDoc is still syncing
        writePromise
          .then((resolvedRef) => {
            if (resolvedRef?.id) {
              setSubmittedRecord((prev) => (prev ? { ...prev, uid: resolvedRef.id } : prev));
            }
          })
          .catch((err) => console.warn('Deferred addDoc notice:', err));
      }

      // Also sync any existing deterministic doc for the same email to 'pending' so stale records never shadow it
      const existingForEmail = onboardingRequests.filter(
        (r) => (r.email || '').trim().toLowerCase() === cleanEmail && r.id !== finalDocId
      );
      if (existingForEmail.length > 0) {
        existingForEmail.forEach((oldReq) => {
          setDoc(
            doc(db, 'access_requests', oldReq.id),
            {
              fullName: cleanName,
              name: cleanName,
              email: cleanEmail,
              status: 'pending',
              createdAt: serverTimestamp(),
              updatedAt: isoTimestamp,
            },
            { merge: true }
          ).catch(() => {});
        });
      }

      // 3. Immediately update in-memory onboardingRequests state so Admin Nexus Pending Queue updates instantly
      await registerAccessRequest({
        name: cleanName,
        fullName: cleanName,
        email: cleanEmail,
        discipline: userDiscipline,
        reasonForAccess: userReason,
        uid: finalDocId,
        organization: userDiscipline,
        accessReason: userReason,
        skipFirestoreWrite: true,
      });

      // Dispatch real-time window event so open Admin Nexus tabs/views instantly register the incoming request
      try {
        window.dispatchEvent(
          new CustomEvent('bim_access_request_submitted', {
            detail: {
              ...requestPayload,
              id: finalDocId,
              uid: finalDocId,
            },
          })
        );
      } catch {}

      const record: SubmittedRequestData = {
        name: cleanName,
        email: cleanEmail,
        uid: finalDocId,
      };
      setSubmittedRecord(record);
      setSuccessMessage('Request Submitted Successfully!');
      setViewStep('pending');
    } catch (err: any) {
      console.error('Access request Firestore write error:', err);
      const rawMsg = String(err?.message || '');
      if (err?.code === 'permission-denied' || rawMsg.includes('Missing or insufficient permissions')) {
        setErrorMessage('Database permission error while saving your access request. Please contact the Super Administrator.');
      } else if (err?.code === 'resource-exhausted' || rawMsg.includes('Quota exceeded')) {
        setErrorMessage('Firestore database quota temporarily exceeded. Please wait a moment and try again.');
      } else {
        setErrorMessage(
          rawMsg || 'Failed to submit access request to database. Please check your connection and try again.'
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Secondary "Back" link handler
   */
  const handleBack = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (viewStep === 'pending') {
      setViewStep('form');
      setSubmittedRecord(null);
      setErrorMessage(null);
      return;
    }

    if (isModal && onClose) {
      onClose();
      return;
    }

    // Reset input fields
    setFullName('');
    setEmail('');
    setInputErrors({});
    setErrorMessage(null);

    if (typeof window !== 'undefined' && window.history && window.history.length > 1) {
      window.history.back();
    }
  };

  /**
   * Render the Form matching exact UI specification in image.png
   */
  const renderFormView = () => (
    <form onSubmit={handleSubmitRequest} className="space-y-5 my-1">
      {/* Field 1: Full Name */}
      <div className="space-y-2">
        <label htmlFor="bpms-full-name" className="block text-sm font-medium text-slate-300">
          Full Name
        </label>
        <div className="relative">
          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
            <User className="w-4 h-4" />
          </div>
          <input
            id="bpms-full-name"
            type="text"
            autoComplete="name"
            placeholder="Full Name"
            value={fullName}
            onChange={(e) => {
              setFullName(e.target.value);
              if (inputErrors.name) {
                setInputErrors((prev) => ({ ...prev, name: undefined }));
              }
            }}
            className={`w-full pl-10 pr-4 py-3 rounded-xl bg-[#090f1d] border text-sm text-slate-100 placeholder-slate-500 font-normal focus:outline-none transition ${
              inputErrors.name
                ? 'border-rose-500/80 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/40'
                : 'border-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40'
            }`}
          />
        </div>
        {inputErrors.name && (
          <p className="text-[11px] text-rose-400 font-medium pl-1 animate-in fade-in">
            {inputErrors.name}
          </p>
        )}
      </div>

      {/* Field 2: Give your email id */}
      <div className="space-y-2">
        <label htmlFor="bpms-email" className="block text-sm font-medium text-slate-300">
          Give your email id
        </label>
        <div className="relative">
          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none">
            <Mail className="w-4 h-4" />
          </div>
          <input
            id="bpms-email"
            type="email"
            autoComplete="email"
            placeholder="Email Address"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (inputErrors.email) {
                setInputErrors((prev) => ({ ...prev, email: undefined }));
              }
            }}
            className={`w-full pl-10 pr-4 py-3 rounded-xl bg-[#090f1d] border text-sm text-slate-100 placeholder-slate-500 font-normal focus:outline-none transition ${
              inputErrors.email
                ? 'border-rose-500/80 focus:border-rose-500 focus:ring-1 focus:ring-rose-500/40'
                : 'border-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40'
            }`}
          />
        </div>
        {inputErrors.email && (
          <p className="text-[11px] text-rose-400 font-medium pl-1 animate-in fade-in">
            {inputErrors.email}
          </p>
        )}
      </div>

      {errorMessage && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Primary Blue Action Button: "→ Submit Request" */}
      <div className="pt-2">
        <button
          type="submit"
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 py-3.5 px-4 rounded-xl bg-[#1d64f2] hover:bg-[#1557e0] text-white font-bold text-sm shadow-xl shadow-blue-600/35 transition transform active:scale-[0.99] disabled:opacity-50 cursor-pointer"
        >
          {isLoading ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>Submitting Request...</span>
            </>
          ) : (
            <span>&rarr; Submit Request</span>
          )}
        </button>
      </div>

      {/* Non-submitting secondary "Back" link below */}
      <div className="text-center pt-1 pb-1">
        <button
          type="button"
          onClick={handleBack}
          disabled={isLoading}
          className="text-xs text-slate-400 hover:text-white transition inline-block cursor-pointer"
        >
          Back
        </button>
      </div>

      {/* Footer Text */}
      <div className="pt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
          <span>BPMS Enterprise Security</span>
        </span>
        <span>Gated Verification</span>
      </div>
    </form>
  );

  /**
   * Render Pending Approval View
   */
  const renderPendingView = () => (
    <div className="space-y-5 my-2 text-center animate-in fade-in duration-200">
      <div className="flex flex-col items-center gap-2">
        <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          Status: Pending
        </span>
      </div>

      <h1 className="text-xl font-bold text-white tracking-tight">
        {successMessage || 'Request Submitted Successfully!'}
      </h1>

      {activeUser?.email && (
        <div className="px-3.5 py-2.5 rounded-xl bg-slate-900/90 border border-slate-800 text-xs text-slate-300 space-y-0.5">
          <div className="font-semibold text-white">{activeUser.name}</div>
          <div className="font-mono text-slate-400 text-[11px]">{activeUser.email}</div>
        </div>
      )}

      <p className="text-sm text-slate-400 max-w-sm mx-auto leading-relaxed">
        Your request has been sent to the Super Admin. Please wait for approval.
      </p>

      <div className="pt-2">
        <button
          type="button"
          onClick={() => {
            setViewStep('form');
            setSubmittedRecord(null);
            setFullName('');
            setEmail('');
            setInputErrors({});
            setErrorMessage(null);
            setSuccessMessage(null);
            if (!isModal && (currentUser?.status || '').toUpperCase() !== 'APPROVED') {
              logout();
              signOut();
            }
            if (isModal && onClose) {
              onClose();
            }
          }}
          className="w-full py-3.5 px-4 rounded-xl bg-[#1d64f2] hover:bg-[#1557e0] text-white font-bold text-sm shadow-xl shadow-blue-600/30 transition transform active:scale-[0.99] cursor-pointer"
        >
          Back to Login
        </button>
      </div>
    </div>
  );

  const cardContent = (
    <div className="w-full max-w-[420px] bg-[#0c1427]/95 border border-slate-800/80 rounded-3xl p-6 sm:p-8 shadow-2xl relative z-10 text-slate-100 backdrop-blur-xl">
      {isModal && onClose && (
        <div className="flex justify-end -mt-2 -mr-2 mb-2">
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {viewStep === 'form' ? renderFormView() : renderPendingView()}
    </div>
  );

  if (isModal) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
        {cardContent}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060a17] text-slate-100 flex flex-col items-center justify-center p-4 sm:p-6 relative overflow-hidden">
      {/* Ambient background lighting */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[34rem] h-[34rem] bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header Banner matching image.png */}
      <div className="mb-7 flex items-center gap-3.5 relative z-10">
        {/* Blue icon with glowing rounded-2xl square */}
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-[#1d64f2] to-[#3b82f6] flex items-center justify-center text-white font-bold shadow-xl shadow-blue-500/30 shrink-0">
          <Building2 className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">ProductionPulse BPMS</h1>
          <p className="text-xs text-slate-400">Enterprise BIM Process & Workforce Management</p>
        </div>
      </div>

      {cardContent}
    </div>
  );
};
