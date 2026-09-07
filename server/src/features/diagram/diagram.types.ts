/**
 * The payload every drawn diagram in this server produces, and the one page both clients render it
 * with.
 *
 * Two questions in this editor are about a shape rather than about a list: where a part's resources
 * come from and go, and what a part's effects fire in what order. Each of them was a report the
 * reader had to hold in their head to see the shape of. They differ only in what the boxes and the
 * arrows stand for, so they share one payload and one renderer, and a third of them costs a builder
 * rather than a webview.
 *
 * The renderer draws whatever it is given and reads nothing about Cosmoteer. Every judgement about
 * what is certain, what is a lower bound and what could not be resolved is made here and carried in
 * the payload, since a picture that quietly drops what it could not work out is the one way a
 * diagram lies.
 */

/** What a box stands for, which decides how the page colours it. */
export type DiagramNodeKind =
    | /** A group or member inside a file. */ 'member'
    | /** A part component. */ 'component'
    | /** A resource type. */ 'resource'
    | /** The world outside the part, where a resource comes from or goes. */ 'outside'
    | /** Something named but not found. */ 'missing';

/** What an arrow stands for, which decides how the page draws it. */
export type DiagramEdgeKind =
    | /** Something flows from one box to the other. */ 'flow'
    | /** A relation the reader is being warned about. */ 'warning';

/** A place a box links to. */
export interface DiagramPlace {
    readonly uri: string;
    /** One-based, the way an editor counts. */
    readonly line: number;
}

/** One box. */
export interface DiagramNode {
    readonly id: string;
    readonly label: string;
    /** The second line of the box, usually where it lives or what kind it is. */
    readonly detail?: string;
    readonly kind: DiagramNodeKind;
    /** Where clicking the box goes. Absent for a box that stands for nothing on disk. */
    readonly place?: DiagramPlace;
}

/** One arrow. */
export interface DiagramEdge {
    readonly from: string;
    readonly to: string;
    readonly label?: string;
    readonly kind: DiagramEdgeKind;
    /**
     * What this arrow belongs with, so the page gives every series its own colour and a swatch in
     * the legend: the resource moving along it in a resource flow, the trigger a chain starts from in
     * a firing chain. Absent, the arrow takes the plain colour of its kind.
     */
    readonly series?: string;
}

/** A whole diagram, ready to draw. */
export interface Diagram {
    readonly title: string;
    readonly subtitle?: string;
    readonly nodes: readonly DiagramNode[];
    readonly edges: readonly DiagramEdge[];
    /** What each colour means in this diagram, since the kinds are shared and the words are not. */
    readonly legend: ReadonlyArray<{ readonly kind: DiagramNodeKind | DiagramEdgeKind; readonly label: string }>;
    /** Sentences printed under the drawing: what it leaves out, and what it cannot stand behind. */
    readonly notes?: readonly string[];
}
