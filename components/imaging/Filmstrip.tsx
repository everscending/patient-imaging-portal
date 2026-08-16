'use client'

export type FilmstripImage = {
  id: string
  ordinal: number
  thumbUrl: string | null
}

type FilmstripProps = {
  images: FilmstripImage[]
  selectedImageId: string | undefined
  onSelect: (imageId: string) => void
}

/** A deliberately small seam: shared viewers do not mount this control. */
export function Filmstrip({ images, selectedImageId, onSelect }: FilmstripProps) {
  return (
    <nav className="pip-filmstrip" aria-label="Study images" data-testid="image-filmstrip">
      {images.map((image) => (
        <button
          aria-current={image.id === selectedImageId ? 'true' : undefined}
          aria-label={`View image ${image.ordinal}`}
          className="pip-filmstrip-item"
          data-testid={`filmstrip-image-${image.id}`}
          key={image.id}
          onClick={() => onSelect(image.id)}
          type="button"
        >
          {image.thumbUrl ? (
            <img alt="" className="pip-filmstrip-thumbnail" loading="lazy" src={image.thumbUrl} />
          ) : (
            <span aria-hidden="true">{image.ordinal}</span>
          )}
        </button>
      ))}
      <style jsx>{`
        .pip-filmstrip {
          display: flex;
          gap: 0.5rem;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
          overflow-x: auto;
          padding: 0.5rem;
          background: var(--pip-color-base-200);
        }
        .pip-filmstrip-item {
          display: grid;
          flex: 0 0 auto;
          place-items: center;
          width: var(--pip-tap-target);
          min-width: var(--pip-tap-target);
          height: var(--pip-tap-target);
          padding: 0;
          overflow: hidden;
          border: 2px solid transparent;
          border-radius: 0.375rem;
          color: var(--pip-color-base-content);
          background: var(--pip-color-base-300);
          cursor: pointer;
        }
        .pip-filmstrip-item[aria-current='true'] { border-color: var(--pip-color-accent); }
        .pip-filmstrip-item:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
        .pip-filmstrip-thumbnail { width: 100%; height: 100%; object-fit: cover; }
      `}</style>
    </nav>
  )
}
