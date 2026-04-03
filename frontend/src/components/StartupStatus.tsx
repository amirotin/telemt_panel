import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCw, Loader2 } from 'lucide-react';
import { panelApi } from '@/lib/api';
import { ConfirmDialog } from './ConfirmDialog';

interface StartupStatusProps {
  status?: string;
  stage?: string;
  progressPct?: number;
}

export function StartupStatus({ status, stage, progressPct }: StartupStatusProps) {
  const [restarting, setRestarting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const isReady = status === 'ready' && progressPct === 100;

  const handleRestart = async () => {
    setShowConfirm(false);
    setRestarting(true);
    try {
      await panelApi.post('/telemt/restart');
    } catch (err) {
      console.error('Restart failed:', err);
    } finally {
      setTimeout(() => setRestarting(false), 5000);
    }
  };

  return (
    <>
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">Service Status</h3>
          <Button
            variant="outline"
            onClick={() => setShowConfirm(true)}
            disabled={restarting}
          >
            {restarting ? (
              <>
                <Loader2 size={14} className="animate-spin mr-1.5" />
                Restarting...
              </>
            ) : (
              <>
                <RotateCw size={14} className="mr-1.5" />
                Restart
              </>
            )}
          </Button>
        </div>

        {!isReady && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-text-secondary">Status:</span>
              <span className="text-text-primary font-medium">{status || 'unknown'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-text-secondary">Stage:</span>
              <span className="text-text-primary font-medium">{stage || 'unknown'}</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-text-secondary">Progress:</span>
                <span className="text-text-primary font-medium">{progressPct?.toFixed(0) || 0}%</span>
              </div>
              <div className="w-full bg-background rounded-full h-2 overflow-hidden">
                <div
                  className="bg-accent h-full transition-all duration-300"
                  style={{ width: `${progressPct || 0}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {isReady && (
          <div className="flex items-center gap-2 text-sm text-success">
            <div className="w-2 h-2 bg-success rounded-full animate-pulse" />
            Service is ready
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        title="Restart Telemt Service"
        message="Are you sure you want to restart the Telemt service? Active connections will be dropped."
        confirmLabel="Restart"
        onConfirm={handleRestart}
      />
    </>
  );
}
