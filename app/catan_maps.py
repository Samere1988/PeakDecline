"""Geometry for the larger base-game island. The original four-player board stays in catan_rules."""

def extended_geometry():
    vertices, edges, tiles = [], [], []
    vertex_ids = {}
    edge_ids = {}
    rows = (3, 4, 5, 6, 5, 4, 3)
    corners = ((8, 0), (16, 4.5), (16, 13.5), (8, 18), (0, 13.5), (0, 4.5))
    for row, count in enumerate(rows):
        y = 1 + row * 13.5
        for column in range(count):
            x = (100 - 16 * count) / 2 + 16 * column
            ids = []
            for dx, dy in corners:
                point = (x + dx, y + dy)
                if point not in vertex_ids:
                    vertex_ids[point] = len(vertices)
                    vertices.append(dict(id=len(vertices), x=point[0], y=point[1], tiles=[], edges=[]))
                vertex = vertex_ids[point]
                vertices[vertex]['tiles'].append(len(tiles))
                ids.append(vertex)
            for a, b in zip(ids, ids[1:] + ids[:1]):
                key = tuple(sorted((a, b)))
                if key not in edge_ids:
                    edge_ids[key] = len(edges)
                    edges.append(dict(id=len(edges), ends=[a, b], tiles=[]))
                    vertices[a]['edges'].append(edge_ids[key])
                    vertices[b]['edges'].append(edge_ids[key])
                edges[edge_ids[key]]['tiles'].append(len(tiles))
            tiles.append(dict(id=len(tiles), x=x, y=y, corners=ids))

    # The eleven port edges follow the Colonist 5–6 island coastline, clockwise
    # from the northwest. Equal spacing puts boats on different shore corners.
    selected = (5, 15, 27, 67, 84, 97, 104, 101, 89, 73, 34)
    assert all(len(edges[edge]['tiles']) == 1 for edge in selected)
    assert len({vertex for edge in selected for vertex in edges[edge]['ends']}) == 22
    port_types = ('any', 'wood', 'any', 'sheep', 'any', 'wheat',
                  'any', 'brick', 'sheep', 'ore', 'any')
    ports = [dict(edge=edge, type=kind) for edge, kind in zip(selected, port_types)]
    return dict(vertices=vertices, edges=edges, tiles=tiles, ports=ports)


EXTENDED = extended_geometry()
