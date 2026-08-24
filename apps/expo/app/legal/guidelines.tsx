import { LegalDocument } from '@/src/components/legal/LegalDocument';

/**
 * Community guidelines — referenced from Settings and from the report flow, both
 * of which previously pointed at a dead button.
 */
export default function CommunityGuidelinesScreen() {
  return (
    <LegalDocument
      docKey="communityGuidelines"
      title="Community Guidelines"
      emptyMessage="Our community guidelines have not been published yet. In the meantime: be respectful, post only content you own, and report anything that looks abusive."
    />
  );
}
